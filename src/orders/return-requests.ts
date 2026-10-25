import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	returnRequestLines,
	returnRequests,
} from "#/db/schema";
import { errorText } from "#/diagnostics/runs";

// Returns buyers opened on a marketplace, as each channel's importer reads
// them (amazon-returns.ts, shopify-returns.ts, ebay-returns.ts), saved one
// way so the Returns pages and order_line_returns read them alike.

export type ReturnStatus = (typeof returnRequests.$inferInsert)["status"];
// A refund with nothing coming back never ships (return_requests_refund_never_ships).
export type RefundStatus = Extract<
	ReturnStatus,
	"requested" | "closed" | "cancelled"
>;
// What was asked for, and where it stands.
export type RequestStage =
	| { kind: "return"; status: ReturnStatus }
	| { kind: "refund"; status: RefundStatus };

export type ChannelReturn = RequestStage & {
	// The marketplace's id for the return, unique per channel.
	externalId: string;
	// The order's id there, as orders.externalId stores it.
	orderExternalId: string;
	// Where it really sold, when another marketplace relayed it (a TikTok
	// order Shopify passed on: "tiktok:<id>"). Such an order may since have
	// moved to that marketplace's store, so it's found by this instead.
	marketplaceOrderId?: string | null;
	// The marketplace's own wording.
	rawStatus: string;
	// Why, as the marketplace names it (a code or its words).
	reason: string | null;
	// What the buyer wrote, when they wrote anything. Left out when it wasn't
	// asked for or couldn't be read: a note already saved stays as it is.
	note?: string | null;
	// The note was asked for and couldn't be read, so it's asked again
	// later. Left out keeps what's saved.
	noteUnread?: boolean;
	trackingNumber: string | null;
	carrier: string | null;
	requestedAt: Date;
	// When the marketplace last changed it, by the time its search goes by
	// (TikTok's update time, a Shopify order's). Left out where the search
	// goes by when it was opened: requestedAt is that time.
	updatedAt?: Date;
	lines: {
		// The line's id there, as order_lines.externalId stores it.
		lineExternalId: string | null;
		sku: string | null;
		quantity: number;
	}[];
};

// Just the stage, so a snapshot carries nothing else of the return.
const stageOf = (r: RequestStage): RequestStage =>
	r.kind === "return"
		? { kind: "return", status: r.status }
		: { kind: "refund", status: r.status };

type Line = { id: number; externalId: string; sku: string | null };

// Which of the order's lines a returned item was: by the line's id, then
// its SKU, then the only line there is. None when it's still unclear.
export function matchLine(
	lines: Line[],
	item: ChannelReturn["lines"][number],
): number | null {
	const byId = item.lineExternalId
		? lines.find((l) => l.externalId === item.lineExternalId)
		: undefined;
	if (byId) return byId.id;
	const bySku = item.sku ? lines.filter((l) => l.sku === item.sku) : [];
	if (bySku.length === 1) return bySku[0].id;
	return lines.length === 1 ? lines[0].id : null;
}

// What a return saves as, with its lines matched to ours. A fresh read that
// makes the same snapshot as the saved one needs no write. Lines compare as a
// set, since their order means nothing; a line that has since matched a
// different order line changes its orderLineId, so the snapshot changes too.
type Snapshot = RequestStage & {
	orderId: number;
	rawStatus: string;
	reason: string | null;
	note: string | null;
	noteUnread: boolean;
	trackingNumber: string | null;
	carrier: string | null;
	requestedAt: Date;
	// Null when the marketplace never said and nothing is saved yet.
	sourceUpdatedAt: Date | null;
	lines: { orderLineId: number | null; sku: string | null; quantity: number }[];
};

// As read back from the database, where kind and status are two columns.
type Saved = Omit<Snapshot, keyof RequestStage> & {
	kind: RequestStage["kind"];
	status: ReturnStatus;
};

function canonical(s: Saved) {
	return JSON.stringify([
		s.orderId,
		s.kind,
		s.status,
		s.rawStatus,
		s.reason,
		s.note,
		s.noteUnread,
		s.trackingNumber,
		s.carrier,
		s.requestedAt.getTime(),
		s.sourceUpdatedAt?.getTime() ?? null,
		s.lines
			.map((l) => JSON.stringify([l.orderLineId, l.sku, l.quantity]))
			.sort(),
	]);
}

// Saves each return against its order in this store, replacing what the
// marketplace said before. A return for an order katasync doesn't have
// (older than its history, or never synced) is skipped, and its order named
// in missing and handed back in unsaved, so the pass can hold its place. A
// return that hasn't changed since it was saved is left alone.
export async function saveReturns(
	db: Db,
	store: { id: number; channel: ChannelReturnChannel },
	returns: ChannelReturn[],
): Promise<{
	saved: number;
	skipped: number;
	missing: string[];
	unsaved: ChannelReturn[];
}> {
	if (returns.length === 0)
		return { saved: 0, skipped: 0, missing: [], unsaved: [] };
	const known = await db
		.select({ id: orders.id, externalId: orders.externalId })
		.from(orders)
		.where(
			and(
				eq(orders.storeId, store.id),
				inArray(orders.externalId, [
					...new Set(returns.map((r) => r.orderExternalId)),
				]),
			),
		);
	const orderIds = new Map(known.map((o) => [o.externalId, o.id]));
	const relayed = returns.flatMap((r) => r.marketplaceOrderId ?? []);
	const moved =
		relayed.length > 0
			? await db
					.select({ id: orders.id, key: orders.marketplaceOrderId })
					.from(orders)
					.where(inArray(orders.marketplaceOrderId, [...new Set(relayed)]))
			: [];
	const movedIds = new Map(moved.map((o) => [o.key, o.id]));
	// Each return with its order here; no orderId when katasync doesn't have it.
	const placed = returns.map((r) => ({
		r,
		orderId:
			orderIds.get(r.orderExternalId) ??
			(r.marketplaceOrderId ? movedIds.get(r.marketplaceOrderId) : undefined),
	}));
	// Read once for the whole batch rather than once per return: the order
	// lines to match against, and what's saved already.
	const placedIds = [...new Set(placed.flatMap((p) => p.orderId ?? []))];
	const lineRows =
		placedIds.length > 0
			? await db
					.select({
						id: orderLines.id,
						orderId: orderLines.orderId,
						externalId: orderLines.externalId,
						sku: orderLines.sku,
					})
					.from(orderLines)
					.where(inArray(orderLines.orderId, placedIds))
			: [];
	const linesOf = new Map<number, Line[]>();
	for (const l of lineRows) {
		const bucket = linesOf.get(l.orderId);
		if (bucket) bucket.push(l);
		else linesOf.set(l.orderId, [l]);
	}
	const requests = await db
		.select({
			id: returnRequests.id,
			externalId: returnRequests.externalId,
			orderId: returnRequests.orderId,
			kind: returnRequests.kind,
			status: returnRequests.status,
			rawStatus: returnRequests.rawStatus,
			reason: returnRequests.reason,
			note: returnRequests.note,
			noteUnread: returnRequests.noteUnread,
			trackingNumber: returnRequests.trackingNumber,
			carrier: returnRequests.carrier,
			requestedAt: returnRequests.requestedAt,
			sourceUpdatedAt: returnRequests.sourceUpdatedAt,
		})
		.from(returnRequests)
		.where(
			and(
				eq(returnRequests.billedBy, store.channel),
				inArray(returnRequests.externalId, [
					...new Set(returns.map((r) => r.externalId)),
				]),
			),
		);
	const requestLines =
		requests.length > 0
			? await db
					.select({
						requestId: returnRequestLines.requestId,
						orderLineId: returnRequestLines.orderLineId,
						sku: returnRequestLines.sku,
						quantity: returnRequestLines.quantity,
					})
					.from(returnRequestLines)
					.where(
						inArray(
							returnRequestLines.requestId,
							requests.map((q) => q.id),
						),
					)
			: [];
	const linesOfRequest = new Map<number, Snapshot["lines"]>();
	for (const l of requestLines) {
		const line = {
			orderLineId: l.orderLineId,
			sku: l.sku,
			quantity: l.quantity,
		};
		const bucket = linesOfRequest.get(l.requestId);
		if (bucket) bucket.push(line);
		else linesOfRequest.set(l.requestId, [line]);
	}
	const savedBy = new Map(
		requests.map((q) => [
			q.externalId,
			{ ...q, lines: linesOfRequest.get(q.id) ?? [] },
		]),
	);
	let saved = 0;
	const missing = new Set<string>();
	const unsaved: ChannelReturn[] = [];
	for (const { r, orderId } of placed) {
		if (orderId === undefined) {
			unsaved.push(r);
			// A Shopify gid reads as its number.
			missing.add(r.orderExternalId.split("/").pop() ?? r.orderExternalId);
			continue;
		}
		const current = savedBy.get(r.externalId);
		const lines = linesOf.get(orderId) ?? [];
		const next: Snapshot = {
			orderId,
			...stageOf(r),
			rawStatus: r.rawStatus,
			reason: r.reason,
			// A note the marketplace didn't send keeps the one saved.
			note: r.note === undefined ? (current?.note ?? null) : r.note,
			noteUnread: r.noteUnread ?? current?.noteUnread ?? false,
			trackingNumber: r.trackingNumber,
			carrier: r.carrier,
			requestedAt: r.requestedAt,
			sourceUpdatedAt: r.updatedAt ?? current?.sourceUpdatedAt ?? null,
			lines: r.lines.map((l) => ({
				orderLineId: matchLine(lines, l),
				sku: l.sku,
				quantity: l.quantity,
			})),
		};
		if (current && canonical(current) === canonical(next)) {
			saved++;
			continue;
		}
		await db.transaction(async (tx) => {
			const values = {
				orderId,
				billedBy: store.channel,
				externalId: r.externalId,
				kind: next.kind,
				status: next.status,
				rawStatus: next.rawStatus,
				reason: next.reason,
				note: next.note,
				noteUnread: next.noteUnread,
				trackingNumber: next.trackingNumber,
				carrier: next.carrier,
				requestedAt: next.requestedAt,
				// Without the marketplace's time, when it changed here.
				sourceUpdatedAt: r.updatedAt ?? new Date(),
			};
			const [request] = await tx
				.insert(returnRequests)
				.values(values)
				.onConflictDoUpdate({
					target: [returnRequests.billedBy, returnRequests.externalId],
					set: { ...values, syncedAt: sql`now()` },
				})
				.returning({ id: returnRequests.id });
			await tx
				.delete(returnRequestLines)
				.where(eq(returnRequestLines.requestId, request.id));
			if (next.lines.length > 0)
				await tx
					.insert(returnRequestLines)
					.values(next.lines.map((l) => ({ requestId: request.id, ...l })));
		});
		saved++;
	}
	return {
		saved,
		skipped: returns.length - saved,
		missing: [...missing],
		unsaved,
	};
}

type ChannelReturnChannel = (typeof returnRequests.$inferInsert)["billedBy"];

// A record a read found but couldn't save, at the marketplace time its
// search found it by: the pass keeps a gap open there (feed_gaps) until a
// read of it saves.
export type Held = { at: Date; detail: string };

// What a channel's returns read hands back. held: records it found but
// couldn't save whole (a Shopify return too big for one read).
export type FoundReturns =
	| ChannelReturn[]
	| { returns: ChannelReturn[]; problems: string[]; held?: Held[] };

export type ReturnsRead =
	| { kind: "read"; problems: string[]; held: Held[] }
	| { kind: "failed"; error: string }
	| { kind: "pending" };

// One read of a channel's returns, saved. Returns come from their own API,
// often with a permission of its own; when that fails it's the returns feed
// that failed, not the channel. A return for an order katasync doesn't have
// is held: its box would turn up unexpected, and nothing past it is
// verified until it saves. Null from fetch means nothing to read yet (a
// report still being built).
export async function importReturns(
	db: Db,
	store: { id: number; channel: ChannelReturnChannel; name: string },
	fetch: () => Promise<FoundReturns | null>,
): Promise<ReturnsRead> {
	try {
		const found = await fetch();
		if (!found) return { kind: "pending" };
		const { returns, problems, held } = Array.isArray(found)
			? { returns: found, problems: [], held: [] }
			: { ...found, held: found.held ?? [] };
		const { unsaved } = await saveReturns(db, store, returns);
		return {
			kind: "read",
			problems,
			held: [
				...held,
				...unsaved.map((r) => ({
					at: r.updatedAt ?? r.requestedAt,
					detail: `${store.name} return for order ${r.orderExternalId.split("/").pop()}, which katasync doesn't have`,
				})),
			],
		};
	} catch (error) {
		return { kind: "failed", error: errorText(error) };
	}
}
