import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	returnRequestLines,
	returnRequests,
} from "#/db/schema";

// Returns buyers opened on a marketplace, as each channel's importer reads
// them (amazon-returns.ts, shopify-returns.ts, ebay-returns.ts), saved one
// way so the Returns pages and order_line_returns read them alike.

export type ReturnStatus = (typeof returnRequests.$inferInsert)["status"];

export type ChannelReturn = {
	// The marketplace's id for the return, unique per channel.
	externalId: string;
	// The order's id there, as orders.externalId stores it.
	orderExternalId: string;
	// Where it really sold, when another marketplace relayed it (a TikTok
	// order Shopify passed on: "tiktok:<id>"). Such an order may since have
	// moved to that marketplace's store, so it's found by this instead.
	marketplaceOrderId?: string | null;
	status: ReturnStatus;
	// The marketplace's own wording.
	rawStatus: string;
	// Why, as the marketplace names it (a code or its words).
	reason: string | null;
	// What the buyer wrote, when they wrote anything.
	note: string | null;
	trackingNumber: string | null;
	carrier: string | null;
	requestedAt: Date;
	lines: {
		// The line's id there, as order_lines.externalId stores it.
		lineExternalId: string | null;
		sku: string | null;
		quantity: number;
	}[];
};

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

// Saves each return against its order in this store, replacing what the
// marketplace said before. A return for an order katasync doesn't have
// (older than its history, or never synced) is skipped, and its order named
// in missing.
export async function saveReturns(
	db: Db,
	store: { id: number; channel: ChannelReturnChannel },
	returns: ChannelReturn[],
): Promise<{ saved: number; skipped: number; missing: string[] }> {
	if (returns.length === 0) return { saved: 0, skipped: 0, missing: [] };
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
	let saved = 0;
	const missing = new Set<string>();
	for (const r of returns) {
		const orderId =
			orderIds.get(r.orderExternalId) ??
			(r.marketplaceOrderId ? movedIds.get(r.marketplaceOrderId) : undefined);
		if (orderId === undefined) {
			// A Shopify gid reads as its number.
			missing.add(r.orderExternalId.split("/").pop() ?? r.orderExternalId);
			continue;
		}
		await db.transaction(async (tx) => {
			const lines = await tx
				.select({
					id: orderLines.id,
					externalId: orderLines.externalId,
					sku: orderLines.sku,
				})
				.from(orderLines)
				.where(eq(orderLines.orderId, orderId));
			const values = {
				orderId,
				billedBy: store.channel,
				externalId: r.externalId,
				status: r.status,
				rawStatus: r.rawStatus,
				reason: r.reason,
				note: r.note,
				trackingNumber: r.trackingNumber,
				carrier: r.carrier,
				requestedAt: r.requestedAt,
				sourceUpdatedAt: new Date(),
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
			if (r.lines.length > 0)
				await tx.insert(returnRequestLines).values(
					r.lines.map((l) => ({
						requestId: request.id,
						orderLineId: matchLine(lines, l),
						sku: l.sku,
						quantity: l.quantity,
					})),
				);
		});
		saved++;
	}
	return { saved, skipped: returns.length - saved, missing: [...missing] };
}

type ChannelReturnChannel = (typeof returnRequests.$inferInsert)["billedBy"];

// One sync pass's returns for a channel, as problems to report. Returns
// come from their own API, often with a permission of its own; when that
// fails the pass names it and orders still sync. A return for an order
// katasync doesn't have is named too: its box would turn up unexpected.
// Null from fetch means nothing to read yet (a report still being built).
export async function importReturns(
	db: Db,
	store: { id: number; channel: ChannelReturnChannel; name: string },
	fetch: () => Promise<
		ChannelReturn[] | { returns: ChannelReturn[]; problems: string[] } | null
	>,
): Promise<string[]> {
	try {
		const found = await fetch();
		if (!found) return [];
		const { returns, problems } = Array.isArray(found)
			? { returns: found, problems: [] }
			: found;
		const { missing } = await saveReturns(db, store, returns);
		if (missing.length > 0)
			problems.push(
				`${store.name} returns for orders katasync doesn't have: ${missing.join(", ")}`,
			);
		return problems;
	} catch (error) {
		return [
			`${store.name} returns: ${error instanceof Error ? error.message : error}`,
		];
	}
}
