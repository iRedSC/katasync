import { type } from "arktype";
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNull,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrders,
	purchaseOrderTracking,
	type TrackingEvent,
} from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";
import { lacksHistory } from "#/purchasing/tracking-history";
import {
	type Carrier,
	guessCarrier,
	normalTracking,
} from "./inbox/tracking-numbers";

// Packages coming for a PO, followed on Shippo. Only evidence: nothing here
// receives, closes, or otherwise changes the PO.

const status = type(
	"'PRE_TRANSIT' | 'TRANSIT' | 'DELIVERED' | 'RETURNED' | 'FAILURE' | 'UNKNOWN'",
);

const place = type({
	"city?": "string | null",
	"state?": "string | null",
}).or("null");

const event = type({
	status: "string",
	"status_details?": "string | null",
	"status_date?": "string | null",
	"location?": place,
});

const trackResponse = type({
	"eta?": "string | null",
	"original_eta?": "string | null",
	"servicelevel?": type({ "name?": "string | null" }).or("null"),
	"address_from?": place,
	"address_to?": place,
	"tracking_status?": event.or("null"),
	"tracking_history?": event.array().or("null"),
});

// "City, ST", or whichever half the carrier gave.
function placeName(p: typeof place.infer | undefined) {
	const parts = [p?.city?.trim(), p?.state?.trim()].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : null;
}

function statusOf(s: string | undefined) {
	const parsed = status(s);
	return parsed instanceof type.errors ? ("UNKNOWN" as const) : parsed;
}

const date = (s: string | null | undefined) => (s ? new Date(s) : null);

// Shippo is asked about this many numbers at once, so a backlog can't turn
// into a burst of requests.
const CONCURRENCY = 4;
// One request, throttle waits included, gets this long before it counts as
// failed.
const REQUEST_MS = 10_000;
// Waits before trying again after a throttled or failed request. Each wait
// is one more try, so a request is sent at most this many times plus one.
const RETRY_WAITS_MS = [1_000, 3_000];

// Sends one request to Shippo. Throttling (429) and server errors are tried
// again after a wait; the last answer, or the last failure, is final.
async function fetchShippo(url: string, key: string): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const canRetry = attempt < RETRY_WAITS_MS.length;
		try {
			const res = await fetch(url, {
				headers: { Authorization: `ShippoToken ${key}` },
				signal: AbortSignal.timeout(REQUEST_MS),
			});
			const busy = res.status === 429 || res.status >= 500;
			if (!canRetry || !busy) return res;
		} catch (error) {
			if (!canRetry) {
				throw error instanceof Error && error.name === "TimeoutError"
					? new Error(`Shippo didn't answer within ${REQUEST_MS}ms`)
					: error;
			}
		}
		await new Promise((resolve) =>
			setTimeout(resolve, RETRY_WAITS_MS[attempt]),
		);
	}
}

// What Shippo knows now. Throws when Shippo can't be asked.
async function askShippo(carrier: Carrier, number: string) {
	const key = process.env.SHIPPO_API_KEY;
	if (!key) throw new Error("Set SHIPPO_API_KEY to follow tracking");
	const res = await fetchShippo(
		`https://api.goshippo.com/tracks/${carrier}/${encodeURIComponent(number)}`,
		key,
	);
	if (!res.ok)
		throw new Error(`Shippo answered ${res.status}: ${await res.text()}`);
	const t = trackResponse.assert(await res.json());
	const s = t.tracking_status;
	const history: TrackingEvent[] = (t.tracking_history ?? []).map((e) => ({
		status: statusOf(e.status),
		detail: e.status_details?.trim() || null,
		at: e.status_date ?? null,
		place: placeName(e.location),
	}));
	return {
		status: statusOf(s?.status),
		statusDetail: s?.status_details?.trim() || null,
		statusAt: date(s?.status_date),
		eta: date(t.eta),
		originalEta: date(t.original_eta),
		service: t.servicelevel?.name?.trim() || null,
		origin: placeName(t.address_from),
		destination: placeName(t.address_to),
		history,
	};
}

// Asks Shippo about one saved number and keeps the answer. A failure leaves
// what was known and is returned, never thrown, so one bad number doesn't
// stop the rest.
async function check(
	db: Db,
	row: { id: number; carrier: string; number: string },
) {
	try {
		const now = await askShippo(row.carrier as Carrier, row.number);
		await db
			.update(purchaseOrderTracking)
			.set({ ...now, checkedAt: new Date() })
			.where(eq(purchaseOrderTracking.id, row.id));
		return null;
	} catch (error) {
		return `${row.number}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

// Runs `run` on every item, at most `limit` at a time. Results keep the order
// of `items`.
async function eachLimit<T, R>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	const queue = items.entries();
	const worker = async () => {
		for (const [i, item] of queue) results[i] = await run(item);
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
}

const FOLLOWABLE = ["sent", "closed"] as const;

// Puts a number on a PO (once) and asks Shippo about it. The carrier is
// guessed from the number's shape when not given.
export async function addTracking(
	db: Db,
	input: {
		purchaseOrderId: number;
		number: string;
		carrier?: Carrier;
		emailId?: number | null;
	},
) {
	const number = normalTracking(input.number);
	const carrier = input.carrier ?? guessCarrier(number);
	if (!carrier)
		throw new PurchaseOrderError(
			`${input.number} doesn't look like a UPS, USPS, or FedEx number. Give the carrier.`,
		);
	if (!/^[0-9A-Z]{8,40}$/.test(number))
		throw new PurchaseOrderError(`${input.number} isn't a tracking number`);
	const [po] = await db
		.select({ status: purchaseOrders.status })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, input.purchaseOrderId));
	if (!po)
		throw new PurchaseOrderError(`There's no PO ${input.purchaseOrderId}`);
	if (!(FOLLOWABLE as readonly string[]).includes(po.status))
		throw new PurchaseOrderError(
			`PO ${input.purchaseOrderId} is ${po.status}; only sent POs have packages coming`,
		);
	const [row] = await db
		.insert(purchaseOrderTracking)
		.values({
			purchaseOrderId: input.purchaseOrderId,
			carrier,
			number,
			emailId: input.emailId ?? null,
		})
		.onConflictDoNothing()
		.returning();
	if (!row) return { added: false as const, number, carrier };
	const problem = await check(db, row);
	return { added: true as const, id: row.id, number, carrier, problem };
}

export async function removeTracking(db: Db, id: number) {
	const [row] = await db
		.delete(purchaseOrderTracking)
		.where(eq(purchaseOrderTracking.id, id))
		.returning();
	if (!row) throw new PurchaseOrderError(`There's no tracking ${id}`);
	return row;
}

export function trackingOf(db: Db, purchaseOrderId: number) {
	return db
		.select()
		.from(purchaseOrderTracking)
		.where(eq(purchaseOrderTracking.purchaseOrderId, purchaseOrderId))
		.orderBy(asc(purchaseOrderTracking.createdAt));
}

const DONE = ["DELIVERED", "RETURNED"] as const;
// Numbers still not delivered after this long are left alone.
const GIVE_UP_MS = 60 * 86_400_000;

// Asks Shippo again about every package still on its way, and any finished
// one without its history yet (followed before history was kept). Run by the
// cron's four-hourly sweep, when the database is awake anyway.
export async function refreshTracking(db: Db) {
	const rows = await db
		.select({
			id: purchaseOrderTracking.id,
			carrier: purchaseOrderTracking.carrier,
			number: purchaseOrderTracking.number,
		})
		.from(purchaseOrderTracking)
		.where(
			and(
				or(
					isNull(purchaseOrderTracking.status),
					notInArray(purchaseOrderTracking.status, [...DONE]),
					and(
						inArray(purchaseOrderTracking.status, [...DONE]),
						isNull(purchaseOrderTracking.service),
						sql`${purchaseOrderTracking.history} = '[]'::jsonb`,
					),
				),
				gte(purchaseOrderTracking.createdAt, new Date(Date.now() - GIVE_UP_MS)),
			),
		);
	const problems = (
		await eachLimit(rows, CONCURRENCY, (r) => check(db, r))
	).filter((p): p is string => p !== null);
	return { checked: rows.length, problems };
}

// Asks Shippo about a PO's packages that have no scans saved yet (see
// lacksHistory), so its page can show them without waiting for the sweep.
export async function fillHistory(db: Db, purchaseOrderId: number) {
	const rows = (await trackingOf(db, purchaseOrderId)).filter((t) =>
		lacksHistory(t),
	);
	await eachLimit(rows, CONCURRENCY, (r) => check(db, r));
	return rows.length;
}

export type { Carrier };
