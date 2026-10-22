import { and, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, stockLevels } from "#/db/schema";
import { requestOutstanding } from "./ledger";
import { isOurs } from "./locations";

// Shelves waiting on a count. Kept out of src/server/catalog/shelf-counts.ts:
// a plain export there keeps the ledger (node:crypto) in the browser bundle.

// A shelf is due once someone asks for a count, until a count lands after
// the request.
export const countDue = and(requestOutstanding, isOurs);

export async function countCountsDue(db: Db) {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(countDue);
	return row?.count ?? 0;
}
