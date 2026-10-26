import { type AnyColumn, and, eq, or, type SQL, sql } from "drizzle-orm";
import { orders, stores } from "#/db/schema";

// The order a thread is about, as a join condition: by the marketplace's own
// ID, which also finds a TikTok sale Shopify relayed and never handed over
// (it keeps Shopify's ID); a Shopify thread's by Shopify's, in a store of the
// thread's channel, so stores must be joined on it. Server only.

export function isThreadOrder(
	market: AnyColumn | string,
	ref: AnyColumn | string,
): SQL | undefined {
	const key =
		typeof market === "string" && typeof ref === "string"
			? `${market}:${ref}`
			: sql`${market} || ':' || ${ref}`;
	return or(
		and(eq(orders.storeId, stores.id), eq(orders.externalId, ref)),
		eq(orders.marketplaceOrderId, key),
	);
}
