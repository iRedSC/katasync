import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { locations, orders, stockLevels, stores } from "#/db/schema";
import { webhookInbox } from "#/db/webhook-schema";
import { postMovements } from "#/inventory/ledger";
import { ingestOrder } from "#/orders/ingest";
import { createProduct, createTestDb } from "#/test/db";
import { tiktokToChannelOrder } from "./tiktok";
import {
	acceptWebhook,
	backlogSummary,
	drainDue,
	ingestWith,
} from "./webhook-inbox";

vi.mock("#/db/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/db/client")>();
	const lockDb = {
		transaction: async (work: (db: Db) => Promise<unknown>) =>
			work({
				execute: async () => ({ rows: [{ locked: true }] }),
			} as unknown as Db),
	} as unknown as Db;
	return {
		...actual,
		withOwnConnection: (work: (db: Db) => Promise<unknown>) => work(lockDb),
	};
});

vi.mock("#/stock-push/on-change", () => ({ pushMoved: async () => [] }));
vi.mock("#/shipping/pins", () => ({ assignOrderPins: async () => 0 }));

const stockFrom = new Date("2026-10-01T00:00:00Z");
const cancellation = (sku: string) => ({
	id: "577",
	status: "CANCELLED",
	create_time: 1791201600,
	update_time: 1791288000,
	cancel_time: 1791288000,
	line_items: ["unit-1", "unit-2"].map((id) => ({
		id,
		sku_id: "1729",
		seller_sku: sku,
		product_name: sku,
		sku_name: "Default",
		sale_price: "20.00",
	})),
});

let db: Db;
let wrench: number;
let raw = cancellation("BOLT");

beforeEach(async () => {
	db = await createTestDb();
	raw = cancellation("BOLT");
	vi.stubEnv("TIKTOK_CLIENT_KEY", "test-key");
	vi.stubEnv("TIKTOK_CLIENT_SECRET", "test-secret");
	vi.stubEnv("TIKTOK_REFRESH_TOKEN", "test-refresh");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			const path = new URL(input).pathname;
			if (path.endsWith("/token/refresh"))
				return Response.json({
					code: 0,
					data: {
						access_token: "test-access",
						access_token_expire_in: 4102444800,
						refresh_token: "test-refresh",
						refresh_token_expire_in: 4102444800,
					},
				});
			if (path === "/authorization/202309/shops")
				return Response.json({
					code: 0,
					data: {
						shops: [{ cipher: "test-shop", name: "TikTok Shop", region: "US" }],
					},
				});
			if (path === "/order/202309/orders")
				return Response.json({ code: 0, data: { orders: [raw] } });
			throw new Error(`Unexpected request: ${path}`);
		}),
	);
	const [warehouse] = await db
		.insert(locations)
		.values({
			name: "Warehouse",
			kind: "owned",
		})
		.returning();
	const [shopify] = await db
		.insert(stores)
		.values({
			channel: "shopify",
			name: "Shopify",
			stockFrom,
		})
		.returning();
	wrench = await createProduct(db, "WRENCH", "simple");
	await postMovements(db, {
		lines: [
			{
				productId: wrench,
				locationId: warehouse.id,
				delta: 10,
				reason: "opening_balance",
			},
		],
	});
	await ingestOrder(
		db,
		shopify,
		{
			...tiktokToChannelOrder(cancellation("WRENCH")),
			externalId: "gid://shopify/Order/5546",
			name: "#5546",
			cancelledAt: null,
			fulfillmentStatus: "UNFULFILLED",
			lines: [
				{
					externalId: "gid://shopify/LineItem/1",
					listingExternalId: "gid://shopify/ProductVariant/1",
					sku: "WRENCH",
					title: "Wrench",
					quantity: 2,
					unitPrice: 20,
				},
			],
		},
		{ shipping: warehouse.id, store: null, pos: null, storeKeeps: 0 },
	);
});

async function onHand() {
	const [level] = await db
		.select()
		.from(stockLevels)
		.where(eq(stockLevels.productId, wrench));
	return level.onHand;
}

test("a blocked TikTok cancellation remains visible and retries after line repair", async () => {
	expect(await onHand()).toBe(8);
	await acceptWebhook(db, "tiktok", "577", JSON.stringify(raw));
	expect(await drainDue(db, ingestWith(db))).toMatchObject({
		claimed: 1,
		done: 0,
		failed: 1,
	});
	const [pending] = await db.select().from(webhookInbox);
	expect(pending.lastError).toContain("left on Shopify until its lines match");
	expect(pending.failures).toBe(1);
	expect(await backlogSummary(db)).toMatchObject({ pending: 1, failing: 1 });
	const [unchanged] = await db.select().from(orders);
	expect(unchanged).toMatchObject({
		externalId: "gid://shopify/Order/5546",
		cancelledAt: null,
	});
	expect(await onHand()).toBe(8);

	raw = cancellation("WRENCH");
	await db.update(webhookInbox).set({ nextAttemptAt: sql`now()` });
	expect(await drainDue(db, ingestWith(db))).toMatchObject({
		claimed: 1,
		done: 1,
		failed: 0,
	});
	expect(await db.select().from(webhookInbox)).toHaveLength(0);
	const [cancelled] = await db.select().from(orders);
	expect(cancelled.externalId).toBe("577");
	expect(cancelled.cancelledAt).not.toBeNull();
	expect(await onHand()).toBe(10);
});
