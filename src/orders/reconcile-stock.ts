import { and, asc, eq, gt, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { StockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { orderLines, orders, stores } from "#/db/schema";
import { type Channel, errorText } from "#/diagnostics/runs";
import { readQuantityMode } from "#/inventory/commitments";
import { lockRecipes } from "#/inventory/ledger/post";
import { takeStock } from "./ingest";
import { commitmentProductIds, stockEffectMissing } from "./stock-effects";

// Lines that should have taken stock and haven't: mapped to a product, no sale
// batch yet, and on an order that takes stock. The rules are orderTakesStock's
// (ingest.ts), which decides this when a line is first saved. Needs orders and
// stores joined. Diagnostics reads the same lines, so what it shows is what
// reconcileStock still owes.
export const unsettledStock = and(
	isNotNull(orderLines.productId),
	stockEffectMissing,
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
// call. Each line commits before the next. A failure outside the ledger's own
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
		try {
			const pending = await db
				.select({ id: orderLines.id, orderId: orderLines.orderId })
				.from(orderLines)
				.innerJoin(orders, eq(orders.id, orderLines.orderId))
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.where(and(gt(orderLines.id, after), unsettledStock, scopeOf(only)))
				.orderBy(asc(orderLines.id))
				.limit(SETTLE_BATCH);
			for (const line of pending) {
				const settled = await settleLine(db, from, only, line);
				if (settled === null) continue;
				if (settled.problem) result.problems.push(settled.problem);
				else result.lines++;
			}
			if (pending.length < SETTLE_BATCH) return result;
			after = pending.at(-1)?.id ?? after;
		} catch (error) {
			result.problems.push(`Stock not taken: ${errorText(error)}`);
			return result;
		}
	}
}

async function settleLine(
	db: Db,
	from: StockLocations,
	only: StockScope | undefined,
	pending: { id: number; orderId: number },
) {
	return db.transaction(async (tx) => {
		await readQuantityMode(tx);
		const [owner] = await tx
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.id, pending.orderId))
			.for("update");
		if (!owner) return null;
		const [matched] = await tx
			.select({
				line: orderLines,
				order: { name: orders.name, soldInStore: orders.soldInStore },
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(and(eq(orderLines.id, pending.id), unsettledStock, scopeOf(only)));
		if (!matched || matched.line.productId === null) return null;
		await lockRecipes(
			tx,
			[matched.line.productId],
			await commitmentProductIds(tx, [pending.id]),
		);
		const [line] = await tx
			.select()
			.from(orderLines)
			.where(and(eq(orderLines.id, pending.id), stockEffectMissing))
			.for("update");
		if (!line || line.productId !== matched.line.productId) return null;
		return {
			problem: await takeStock(
				tx,
				{ ...line, productId: matched.line.productId },
				matched.order,
				from,
			),
		};
	});
}

function scopeOf(only: StockScope | undefined) {
	if (!only) return undefined;
	return "skus" in only
		? inArray(orderLines.sku, only.skus)
		: eq(stores.channel, only.channel);
}
