import {
	and,
	eq,
	exists,
	gte,
	isNull,
	not,
	or,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	movements,
	orderLines,
	orders,
	productComponents,
	products,
} from "#/db/schema";

// Units sold per stocked product since a date. Tool sets count as their parts,
// since that's what leaves the shelf. A sale the ledger recorded counts the
// movements it took, so a recipe edited later doesn't rewrite it. Other lines
// (before the ledger, or whose sale was undone) count the recipe as it stands.
// Amazon's own (FBA) shipments never take our stock, so reorder leaves them
// out with includeFba false; ABC counts them, since we still buy those units.
export async function soldSince(
	db: Db,
	since: Date,
	{ includeFba }: { includeFba: boolean },
) {
	const sold = soldUnits(db, since, { includeFba });
	const rows = await db
		.select({
			productId: sold.productId,
			units: sql<number>`sum(${sold.units})::int`,
		})
		.from(sold)
		.groupBy(sold.productId);
	return new Map(rows.map((r) => [r.productId, r.units]));
}

// soldSince for reorder (no FBA), per UTC day: day is YYYY-MM-DD. Same
// counting, so a day's units add up to soldSince's.
export async function soldByDay(db: Db, since: Date) {
	const sold = soldUnits(db, since, { includeFba: false });
	return db
		.select({
			productId: sold.productId,
			day: sql<string>`to_char(${sold.placedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
			units: sql<number>`sum(${sold.units})::int`,
		})
		.from(sold)
		.groupBy(sold.productId, sql`2`);
}

// One row per product sold in each counted line: the recorded movements for
// lines the ledger took stock for, and the recipe for the rest. The two sets
// are disjoint, so no line counts twice.
function soldUnits(
	db: Db,
	since: Date,
	{ includeFba }: { includeFba: boolean },
) {
	const counted = and(
		gte(orders.placedAt, since),
		isNull(orders.cancelledAt),
		includeFba ? undefined : eq(orders.fulfilledByChannel, false),
	);
	const recorded = db
		.select({
			productId: movements.productId,
			placedAt: orders.placedAt,
			units: sql<number>`-${movements.delta}`.as("units"),
		})
		.from(movements)
		.innerJoin(orderLines, eq(orderLines.saleBatchId, movements.batchId))
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.where(
			and(
				eq(movements.reason, "sale"),
				not(wasUndone(db, movements.batchId)),
				counted,
			),
		);
	const byRecipe = db
		.select({
			productId:
				sql<number>`coalesce(${productComponents.componentProductId}, ${orderLines.productId})`.as(
					"productId",
				),
			placedAt: orders.placedAt,
			units:
				sql<number>`${orderLines.quantity} * coalesce(${productComponents.quantity}, 1)`.as(
					"units",
				),
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(products, eq(products.id, orderLines.productId))
		.leftJoin(
			productComponents,
			and(
				eq(productComponents.parentProductId, orderLines.productId),
				eq(products.kind, "bundle"),
			),
		)
		.where(
			and(
				counted,
				or(
					isNull(orderLines.saleBatchId),
					wasUndone(db, orderLines.saleBatchId),
				),
			),
		);
	return unionAll(recorded, byRecipe).as("sold");
}

// Undoing a batch posts its reversal under this reference, so a batch with
// one was undone.
function wasUndone(db: Db, batchId: SQLWrapper) {
	const undo = alias(movements, "undo");
	return exists(
		db
			.select({ id: undo.id })
			.from(undo)
			.where(eq(undo.reference, sql`'undo:' || ${batchId}::text`)),
	);
}
