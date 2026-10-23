import { sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { stockValue } from "#/db/schema";

// What stock is worth now, per kind of location (the stock_value view), and
// how many shelves hold stock with no cost, which leaves it out.
export async function stockValueByKind(db: Db) {
	return db
		.select({
			kind: stockValue.locationKind,
			value: sql<number>`coalesce(sum(${stockValue.value}), 0)::float8`,
			units: sql<number>`sum(${stockValue.units})::int`,
			uncosted: sql<number>`(count(*) filter (where ${stockValue.unitCost} is null))::int`,
		})
		.from(stockValue)
		.groupBy(stockValue.locationKind)
		.orderBy(stockValue.locationKind);
}
