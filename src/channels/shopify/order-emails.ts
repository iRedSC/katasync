import { type } from "arktype";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { tiktokOrderId } from "./channel-order";
import { shopifyQuery } from "./client";
import type { ShopifyOrder } from "./order-shapes";

// The buyer's email on Shopify's own orders, so staff can email them from
// katasync (src/buyers/shopify-mail.ts). Asked apart from the order sync:
// Order.email is protected customer data, and an app without that access
// gets an error for the whole query, which would stop orders syncing. Here
// it only leaves emails unread; Diagnostics says why.

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const EMAILS_QUERY = `
query OrderEmails($ids: [ID!]!) {
	nodes(ids: $ids) { ... on Order { id email } }
}`;

const answer = type({
	nodes: type({ "id?": "string", "email?": "string | null" })
		.or("null")
		.array(),
});

// The orders worth asking about: a relayed TikTok order's buyer is
// TikTok's to talk to, so it's never asked or kept.
export const ownOrders = (list: Pick<ShopifyOrder, "id" | "tags">[]) =>
	list.filter((o) => tiktokOrderId(o.tags) === null).map((o) => o.id);

// Shopify's answer as an email per order ID; one that isn't an address is
// none.
export function emailsOf(data: unknown) {
	const found = new Map<string, string | null>();
	for (const n of answer.assert(data).nodes) {
		if (!n?.id) continue;
		const email = n.email?.trim().toLowerCase() ?? "";
		found.set(n.id, EMAIL.test(email) ? email : null);
	}
	return found;
}

// Reads and keeps the buyer emails of these orders. The error when Shopify
// wouldn't say, so a sync can carry on without them.
export async function keepShopifyEmails(
	db: Db,
	storeId: number,
	list: Pick<ShopifyOrder, "id" | "tags">[],
) {
	const ids = ownOrders(list);
	if (ids.length === 0) return null;
	let found: Map<string, string | null>;
	try {
		found = emailsOf(await shopifyQuery(EMAILS_QUERY, { ids }));
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	for (const [externalId, email] of found)
		await db
			.update(orders)
			.set({ buyerEmail: email })
			.where(
				and(
					eq(orders.storeId, storeId),
					eq(orders.externalId, externalId),
					// Saved as relayed by another source: still not ours to email.
					isNull(orders.marketplaceOrderId),
					sql`${orders.buyerEmail} is distinct from ${email}`,
				),
			);
	return null;
}
