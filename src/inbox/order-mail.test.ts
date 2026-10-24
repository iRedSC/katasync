import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { marketEmails } from "#/db/schema";
import type { Market } from "#/markets/market";
import { createTestDb } from "#/test/db";
import { orderMail, refsOf } from "./order-mail";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});

async function email(market: Market | null, subject: string, body = "") {
	await db.insert(marketEmails).values({
		messageId: `<${subject}>`,
		market,
		folder: "updates",
		fromAddress: "x@example.com",
		recipients: [],
		subject,
		body,
		receivedAt: new Date(),
	});
}

const relayed = {
	channel: "shopify" as const,
	name: "#5747",
	externalId: "gid://shopify/Order/7652544151615",
	marketplaceOrderId: "tiktok:577461393015542050",
};

test("a relayed order goes by its store's ID, its name, and the marketplace's ID", () => {
	expect(refsOf(relayed)).toEqual([
		{ market: "shopify", by: "id", ref: "gid://shopify/Order/7652544151615" },
		{ market: "shopify", by: "name", ref: "#5747" },
		{ market: "tiktok", by: "id", ref: "577461393015542050" },
	]);
});

test("emails that name the order, and not ones that only contain its number", async () => {
	await email("tiktok", "Return requested", "Order 577461393015542050");
	await email("shopify", "Order #5747 placed");
	await email(null, "Admin", "https://admin.shopify.com/orders/7652544151615");
	// Another order whose name starts the same.
	await email("shopify", "Order #57471 placed");
	// A longer run of digits holding the TikTok ID.
	await email("tiktok", "Payout", "ref 5774613930155420501");
	const found = await orderMail(db, relayed);
	expect(found.emails.map((e) => e.subject).sort()).toEqual([
		"Admin",
		"Order #5747 placed",
		"Return requested",
	]);
	expect(found.threads).toEqual([]);
});
