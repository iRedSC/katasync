import { type AnyColumn, and, eq, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders, returnRequests, returnTracking } from "#/db/schema";
import { normalTracking } from "#/purchasing/inbox/tracking-numbers";
import { returnOrdersById } from "./returns-due";

// The order a scanned return label is for. A label's barcode often carries
// more than its tracking number (USPS puts "420" and the ZIP before it;
// FedEx's 34 digits end with it), so a request whose number the scan ends
// with matches. A packing slip's order number matches too. Server only.

// Shorter than this, a number could end too many scans by chance.
const MIN_TRACKING = 10;

export async function scanReturn(db: Db, scanned: string) {
	const code = normalTracking(scanned.trim()).replace(/^#/, "");
	if (!code) return [];
	// Order numbers compared the same way: Amazon's have dashes.
	const same = (column: AnyColumn) =>
		sql`upper(regexp_replace(${column}, '[\s-]', '', 'g'))`;
	const number = (column: AnyColumn) =>
		sql`upper(regexp_replace(${column}, '[\\s-]', '', 'g'))`;
	const endsScan = (column: AnyColumn) =>
		and(
			isNotNull(column),
			sql`length(${number(column)}) >= ${MIN_TRACKING}`,
			sql`${code} like '%' || ${number(column)}`,
		);
	const [byTracking, byFollowed, byOrder] = await Promise.all([
		db
			.selectDistinct({ id: returnRequests.orderId })
			.from(returnRequests)
			.where(endsScan(returnRequests.trackingNumber)),
		db
			.selectDistinct({ id: returnRequests.orderId })
			.from(returnTracking)
			.innerJoin(
				returnRequests,
				eq(returnRequests.id, returnTracking.returnRequestId),
			)
			.where(endsScan(returnTracking.number)),
		db
			.select({ id: orders.id })
			.from(orders)
			.where(
				or(
					sql`${same(orders.name)} in (${code}, ${`#${code}`})`,
					sql`${same(orders.externalId)} = ${code}`,
					sql`${same(orders.marketplaceOrderId)} = ${code}`,
				),
			)
			.limit(5),
	]);
	const ids = [
		...new Set([...byTracking, ...byFollowed, ...byOrder].map((r) => r.id)),
	];
	return returnOrdersById(db, ids);
}
