import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { marketplaceCases, openCases, orders, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { type MarketplaceCase, saveMarketplaceCase } from "./marketplace-cases";
import { openCaseRows } from "./returns-due";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});
const found = () =>
	({
		kind: "inquiry",
		externalId: "I1",
		status: "open",
		waitingOn: "us",
		respondBy: new Date("2026-10-27T12:00:00Z"),
		escalation: null,
		amount: "12.50",
		currency: "USD",
		orderExternalId: "missing-order",
		transactionId: null,
		returnExternalId: null,
		rawStatus: "WAITING_SELLER_RESPONSE",
		nextAction: "Respond",
		caseRef: "I1",
		actionUrl: null,
		requestedAt: new Date("2026-10-26T12:00:00Z"),
		problems: [],
	}) satisfies MarketplaceCase;

test("missing orders stay visible in the shared queue and link when the order arrives", async () => {
	await saveMarketplaceCase(db, "ebay", found());
	expect(await openCaseRows(db)).toMatchObject([
		{
			source: "marketplace",
			orderId: null,
			kind: "inquiry",
			note: "Order not imported",
		},
	]);
	const [store] = await db
		.insert(stores)
		.values({ channel: "ebay", name: "eBay" })
		.returning();
	const [order] = await db
		.insert(orders)
		.values({
			storeId: store.id,
			externalId: "missing-order",
			name: "123",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 20,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	await saveMarketplaceCase(db, "ebay", found());
	expect(await db.select().from(marketplaceCases)).toMatchObject([
		{ orderId: order.id },
	]);
	await saveMarketplaceCase(db, "ebay", {
		...found(),
		externalId: "without-identifiers",
		orderExternalId: null,
		transactionId: null,
	});
	const [unmatched] = await db
		.select()
		.from(marketplaceCases)
		.where(eq(marketplaceCases.externalId, "without-identifiers"));
	expect(unmatched.orderId).toBeNull();
});

test("a changed or removed marketplace deadline rewrites the same row", async () => {
	await saveMarketplaceCase(db, "ebay", found());
	const changed = new Date("2026-10-29T15:00:00Z");
	await saveMarketplaceCase(db, "ebay", { ...found(), respondBy: changed });
	expect(await db.select().from(marketplaceCases)).toMatchObject([
		{ respondBy: changed },
	]);
	await saveMarketplaceCase(db, "ebay", { ...found(), respondBy: null });
	expect(await db.select().from(marketplaceCases)).toMatchObject([
		{ respondBy: null },
	]);
	await saveMarketplaceCase(db, "ebay", {
		...found(),
		status: "closed",
		waitingOn: "nobody",
		respondBy: null,
	});
	expect(await db.select().from(openCases)).toEqual([]);
});

test.each([
	{ status: "closed" as const, waitingOn: "us" as const },
	{ waitingOn: "nobody" as const },
	{ waitingOn: "buyer" as const, respondBy: new Date() },
	{ currency: null },
])("DB rejects illegal obligation combinations: %o", async (illegal) => {
	await saveMarketplaceCase(db, "ebay", found());
	await expect(
		db
			.update(marketplaceCases)
			.set(illegal)
			.where(eq(marketplaceCases.externalId, "I1")),
	).rejects.toThrow();
});

test("IDs are unique per channel and kind and MCP can read orderless cases", async () => {
	await saveMarketplaceCase(db, "ebay", found());
	await saveMarketplaceCase(db, "ebay", { ...found(), kind: "dispute" });
	expect(await db.select().from(openCases)).toHaveLength(2);
	const [permission] = await db
		.select({
			allowed: sql<boolean>`has_table_privilege('katasync_mcp', 'marketplace_cases', 'SELECT')`,
		})
		.from(marketplaceCases)
		.limit(1);
	expect(permission).toMatchObject({ allowed: true });
});
