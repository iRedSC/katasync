import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { marketEmails, orders, stores } from "#/db/schema";
import type { Market } from "#/markets/market";
import { createTestDb } from "#/test/db";
import { MOST_SHOWN, mailOrders, orderRefs } from "./mail-orders";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});

test("each channel's order numbers, once each, as they appear", () => {
	expect(
		orderRefs(
			"Claim on 112-5851788-6038606. eBay 24-15324-58920, TikTok 577634691245248540, again 112-5851788-6038606",
			null,
		),
	).toEqual([
		{ market: "amazon", by: "id", ref: "112-5851788-6038606" },
		{ market: "ebay", by: "id", ref: "24-15324-58920" },
		{ market: "tiktok", by: "id", ref: "577634691245248540" },
	]);
});

test("Shopify's names only in Shopify's emails; its admin links anywhere", () => {
	const text =
		"Order #5747 https://admin.shopify.com/store/x/orders/7652544151615";
	expect(orderRefs(text, "shopify")).toEqual([
		{ market: "shopify", by: "name", ref: "#5747" },
		{ market: "shopify", by: "id", ref: "gid://shopify/Order/7652544151615" },
	]);
	expect(orderRefs(text, "amazon")).toEqual([
		{ market: "shopify", by: "id", ref: "gid://shopify/Order/7652544151615" },
	]);
});

test("a longer run of digits isn't a TikTok order", () => {
	expect(orderRefs("ref 12345678901234567890", "tiktok")).toEqual([]);
});

async function store(channel: Market) {
	const [s] = await db
		.insert(stores)
		.values({ channel, name: channel })
		.returning();
	return s?.id ?? 0;
}

async function order(
	storeId: number,
	externalId: string,
	name: string,
	marketplaceOrderId: string | null = null,
) {
	await db.insert(orders).values({
		storeId,
		externalId,
		name,
		marketplaceOrderId,
		placedAt: new Date(),
		fulfillmentStatus: "Shipped",
		total: 40,
		sourceUpdatedAt: new Date(),
	});
}

async function email(market: Market | null, subject: string, body = "") {
	const [e] = await db
		.insert(marketEmails)
		.values({
			messageId: `<${subject}>`,
			market,
			folder: "updates",
			fromAddress: "x@example.com",
			recipients: [],
			subject,
			body,
			receivedAt: new Date(),
		})
		.returning();
	return e?.id ?? 0;
}

test("every order the email names that katasync has, as it names them", async () => {
	const amazon = await store("amazon");
	const shopify = await store("shopify");
	await order(amazon, "111-0000000-0000001", "111-0000000-0000001");
	await order(amazon, "111-0000000-0000002", "111-0000000-0000002");
	// TikTok's, relayed through Shopify.
	await order(
		shopify,
		"gid://shopify/Order/1",
		"#4276",
		"tiktok:577461393015542050",
	);
	const id = await email(
		null,
		"Two orders",
		"577461393015542050, 111-0000000-0000002, 111-9999999-9999999 and 111-0000000-0000001",
	);
	const found = await mailOrders(db, id);
	expect(found.orders.map((o) => o.name)).toEqual([
		"#4276",
		"111-0000000-0000002",
		"111-0000000-0000001",
	]);
	expect(found.more).toBe(0);
});

test("an email with no order katasync has shows none", async () => {
	const id = await email(
		"amazon",
		"Claim decision on order 112-5851788-6038606",
	);
	expect(await mailOrders(db, id)).toEqual({ orders: [], more: 0 });
});

test("past the most shown, how many more", async () => {
	const amazon = await store("amazon");
	const refs = Array.from(
		{ length: MOST_SHOWN + 2 },
		(_, i) => `111-0000000-000000${i}`,
	);
	for (const r of refs) await order(amazon, r, r);
	const found = await mailOrders(
		db,
		await email("amazon", "Summary", refs.join(" ")),
	);
	expect(found.orders.map((o) => o.name)).toEqual(refs.slice(0, MOST_SHOWN));
	expect(found.more).toBe(2);
});
