import { and, asc, eq, gt, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { StockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { orderLines, orders, stores } from "#/db/schema";
import { type Channel, errorText } from "#/diagnostics/runs";
import { takeStock } from "./ingest";

// Lines that should have taken stock and haven't: mapped to a product, no sale
// batch yet, and on an order that takes stock. The rules are orderTakesStock's
// (ingest.ts), which decides this when a line is first saved. Needs orders and
// stores joined. Diagnostics reads the same lines, so what it shows is what
// reconcileStock still owes.
export const unsettledStock = and(
	isNotNull(orderLines.productId),
	isNull(orderLines.saleBatchId),
	gt(orderLines.quantity, 0),
	eq(orders.fulfilledByChannel, false),
	isNull(orders.cancelledAt),
	isNotNull(stores.stockFrom),
	gte(orders.placedAt, stores.stockFrom),
);

// One channel's lines, or only lines with the given SKUs.
export type StockScope = { channel: Channel } | { skus: string[] };

const SETTLE_BATCH = 200;

// Takes stock now for unsettled lines (within `only`, when given) and returns
// the problems that kept some from taking it. Safe to repeat: a line takes stock
// once, under its own lock, and one that fails stays unsettled for the next
// call. Each batch commits before the next. A failure outside the ledger's own
// rules (the database itself) is reported as a problem and ends this call, but
// doesn't throw, so the sync around it carries on.
export async function reconcileStock(
	db: Db,
	from: StockLocations,
	only?: StockScope,
): Promise<{ lines: number; problems: string[] }> {
	const result = { lines: 0, problems: [] as string[] };
	let after = 0;
	for (;;) {
		const batch = await settleBatch(db, from, only, after).catch(
			(error: unknown) => {
				result.problems.push(`Stock not taken: ${errorText(error)}`);
				return null;
			},
		);
		if (!batch) return result;
		result.lines += batch.taken;
		result.problems.push(...batch.problems);
		if (batch.scanned < SETTLE_BATCH) return result;
		after = batch.lastId;
	}
}

async function settleBatch(
	db: Db,
	from: StockLocations,
	only: StockScope | undefined,
	after: number,
) {
	return db.transaction(async (tx) => {
		const pending = await tx
			.select({
				line: orderLines,
				order: { name: orders.name, soldInStore: orders.soldInStore },
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(and(gt(orderLines.id, after), unsettledStock, scopeOf(only)))
			.orderBy(asc(orderLines.id))
			.limit(SETTLE_BATCH)
			.for("update", { of: orderLines });
		const problems: string[] = [];
		let taken = 0;
		for (const { line, order } of pending) {
			if (line.productId === null) continue;
			const problem = await takeStock(
				tx,
				{ ...line, productId: line.productId },
				order,
				from,
			);
			if (problem) problems.push(problem);
			else taken++;
		}
		return {
			scanned: pending.length,
			lastId: pending.at(-1)?.line.id ?? after,
			taken,
			problems,
		};
	});
}

function scopeOf(only: StockScope | undefined) {
	if (!only) return undefined;
	return "skus" in only
		? inArray(orderLines.sku, only.skus)
		: eq(stores.channel, only.channel);
}
