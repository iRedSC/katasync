import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderLines, orders, productComponents, products } from "#/db/schema";

// Units sold per stocked product since a date. Tool sets count as their parts,
// since that's what leaves the shelf. Amazon's own (FBA) shipments never take
// our stock, so reorder leaves them out with includeFba false; ABC counts
// them, since we still buy those units.
export async function soldSince(
	db: Db,
	since: Date,
	{ includeFba }: { includeFba: boolean },
) {
	const rows = await db
		.select({
			productId: sql<number>`coalesce(${productComponents.componentProductId}, ${orderLines.productId})`,
			units: sql<number>`sum(${orderLines.quantity} * coalesce(${productComponents.quantity}, 1))::int`,
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
				gte(orders.placedAt, since),
				isNull(orders.cancelledAt),
				includeFba ? undefined : eq(orders.fulfilledByChannel, false),
			),
		)
		.groupBy(sql`1`);
	return new Map(rows.map((r) => [r.productId, r.units]));
}

// Tool sets sold since a date, as sets rather than their parts. Cancelled
// and FBA orders are left out, as reorder counts.
export async function setsSoldSince(db: Db, since: Date) {
	const rows = await db
		.select({
			productId: orderLines.productId,
			units: sql<number>`sum(${orderLines.quantity})::int`,
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(products, eq(products.id, orderLines.productId))
		.where(
			and(
				eq(products.kind, "bundle"),
				gte(orders.placedAt, since),
				isNull(orders.cancelledAt),
				eq(orders.fulfilledByChannel, false),
			),
		)
		.groupBy(orderLines.productId);
	return new Map(
		rows.flatMap((r) =>
			r.productId === null ? [] : [[r.productId, r.units] as const],
		),
	);
}

// soldSince for reorder (no FBA), per UTC day: day is YYYY-MM-DD. Same
// counting, so a day's units add up to soldSince's.
export async function soldByDay(db: Db, since: Date) {
	return db
		.select({
			productId: sql<number>`coalesce(${productComponents.componentProductId}, ${orderLines.productId})`,
			day: sql<string>`to_char(${orders.placedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
			units: sql<number>`sum(${orderLines.quantity} * coalesce(${productComponents.quantity}, 1))::int`,
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
				gte(orders.placedAt, since),
				isNull(orders.cancelledAt),
				eq(orders.fulfilledByChannel, false),
			),
		)
		.groupBy(sql`1`, sql`2`);
}
