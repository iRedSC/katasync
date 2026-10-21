import { type } from "arktype";
import { and, asc, eq, gte, isNull, notInArray, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseOrders, purchaseOrderTracking } from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";
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

const trackResponse = type({
	"eta?": "string | null",
	"tracking_status?": type({
		status: "string",
		"status_details?": "string | null",
		"status_date?": "string | null",
	}).or("null"),
});

// What Shippo knows now. Throws when Shippo can't be asked.
async function askShippo(carrier: Carrier, number: string) {
	const key = process.env.SHIPPO_API_KEY;
	if (!key) throw new Error("Set SHIPPO_API_KEY to follow tracking");
	const res = await fetch(
		`https://api.goshippo.com/tracks/${carrier}/${encodeURIComponent(number)}`,
		{ headers: { Authorization: `ShippoToken ${key}` } },
	);
	if (!res.ok)
		throw new Error(`Shippo answered ${res.status}: ${await res.text()}`);
	const t = trackResponse.assert(await res.json());
	const s = t.tracking_status;
	const parsed = status(s?.status);
	return {
		status: parsed instanceof type.errors ? ("UNKNOWN" as const) : parsed,
		statusDetail: s?.status_details?.trim() || null,
		statusAt: s?.status_date ? new Date(s.status_date) : null,
		eta: t.eta ? new Date(t.eta) : null,
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

// Asks Shippo again about every package still on its way. Run by the cron's
// four-hourly sweep, when the database is awake anyway.
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
				),
				gte(purchaseOrderTracking.createdAt, new Date(Date.now() - GIVE_UP_MS)),
			),
		);
	const problems = (await Promise.all(rows.map((r) => check(db, r)))).filter(
		(p): p is string => p !== null,
	);
	return { checked: rows.length, problems };
}

export type { Carrier };
