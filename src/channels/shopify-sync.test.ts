import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { syncShopify } from "./shopify";

// Whole Shopify passes, with Shopify faked: its search honors the cursor,
// and each order's fulfillment read answers as `reads` says at the time.

const money = (amount: string) => ({ shopMoney: { amount } });

const node = (
	id: string,
	updatedAt: string,
	displayFulfillmentStatus: string,
	currentQuantity: number,
) => ({
	id,
	name: `#${id.split("/").pop()}`,
	sourceName: "web",
	tags: [],
	app: null,
	merchantOfRecordApp: null,
	channelInformation: null,
	createdAt: "2026-10-05T08:00:00Z",
	updatedAt,
	cancelledAt: null,
	displayFulfillmentStatus,
	displayFinancialStatus: "PAID",
	totalPriceSet: money("30.00"),
	totalShippingPriceSet: money("0.00"),
	currentTaxLines: [],
	shippingAddress: null,
	lineItems: {
		pageInfo: { hasNextPage: false, endCursor: null },
		nodes: [
			{
				id: `${id}/L`,
				sku: null,
				name: "Blade",
				quantity: 3,
				currentQuantity,
				variant: null,
				discountedUnitPriceAfterAllDiscountsSet: money("10.00"),
			},
		],
	},
});

// A is refunded one unit, so its fulfillments must be read; B's status says
// what shipped. C is partly shipped, so its fulfillments must be read too.
const A = "gid://shopify/Order/1";
const B = "gid://shopify/Order/2";
const C = "gid://shopify/Order/3";
const nodes: Record<string, ReturnType<typeof node>> = {
	[A]: node(A, "2026-10-05T10:00:00.000Z", "PARTIALLY_FULFILLED", 2),
	[B]: node(B, "2026-10-05T11:00:00.000Z", "UNFULFILLED", 3),
	[C]: node(C, "2026-10-05T09:00:00.000Z", "PARTIALLY_FULFILLED", 3),
};

const json = (data: unknown) => new Response(JSON.stringify({ data }));
const down = () => new Response("down", { status: 502 });
const oneShipped = (id: string) =>
	json({
		order: {
			fulfillments: [
				{
					status: "SUCCESS",
					fulfillmentLineItems: {
						pageInfo: { hasNextPage: false },
						nodes: [{ quantity: 1, lineItem: { id: `${id}/L` } }],
					},
				},
			],
		},
	});

let db: Db;
let listed: string[];
let reads: (id: string) => Response;
let byId: string[];
beforeEach(async () => {
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example.com");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
	db = await createTestDb();
	byId = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { query, variables } = JSON.parse(String(init.body));
		if (query.includes("shop { id name }") && !query.includes("order("))
			return json({ shop: { id: "gid://shopify/Shop/1", name: "Shop" } });
		if (query.includes("query Orders")) {
			const since = /updated_at:>='([^']+)'/.exec(variables.query)?.[1] ?? "";
			return json({
				orders: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: listed
						.map((id) => nodes[id])
						.filter((n) => n.updatedAt >= since),
				},
			});
		}
		if (query.includes("query Order(")) {
			byId.push(variables.id);
			return json({
				shop: { id: "gid://shopify/Shop/1", name: "Shop" },
				order: nodes[variables.id],
			});
		}
		if (query.includes("query Shipped")) return reads(variables.id);
		if (query.includes("fulfillmentOrders"))
			return json({
				order: {
					fulfillmentOrders: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [],
					},
				},
			});
		return json({ nodes: [] });
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const pass = () => syncShopify(db, { listings: null });

async function cursor() {
	const [store] = await db.select().from(schema.stores);
	return store.ordersSyncedThrough?.toISOString();
}

async function shipped(id: string) {
	const rows = await db
		.select({ shipped: schema.orderLines.shippedQuantity })
		.from(schema.orderLines)
		.innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
		.where(eq(schema.orders.externalId, id));
	return rows.map((r) => r.shipped);
}

test("an order whose read failed holds the cursor, and the next pass syncs it", async () => {
	listed = [A, B];
	reads = (id) => (id === A ? down() : oneShipped(id));
	const first = await pass();
	expect(first.problems).toEqual([
		expect.stringMatching(/^#1: Shopify's fulfillments couldn't be read/),
	]);
	expect(await shipped(A)).toEqual([]);
	expect(await shipped(B)).toEqual([0]);
	// Not past A, though B is newer.
	expect(await cursor()).toBe(nodes[A].updatedAt);

	reads = oneShipped;
	const second = await pass();
	expect(second.problems).toEqual([]);
	expect(await shipped(A)).toEqual([1]);
	expect(await cursor()).toBe(nodes[B].updatedAt);
});

test("an unknown shipped count the search no longer finds is read again by id", async () => {
	listed = [C];
	reads = down;
	await pass();
	expect(await shipped(C)).toEqual([null]);
	// C hasn't changed since, and the cursor has moved past it.
	listed = [];
	await db
		.update(schema.stores)
		.set({ ordersSyncedThrough: new Date("2026-10-06T00:00:00Z") });
	reads = oneShipped;
	const healed = await pass();
	expect(byId).toEqual([C]);
	expect(healed.problems).toEqual([]);
	expect(await shipped(C)).toEqual([1]);
	// Known now, so later passes leave it be.
	byId = [];
	await pass();
	expect(byId).toEqual([]);
});

test("a failed read again is reported and the pass still finishes", async () => {
	listed = [C];
	reads = down;
	await pass();
	listed = [];
	const again = await pass();
	expect(byId).toEqual([C]);
	expect(again.problems).toEqual([
		expect.stringMatching(/^#3: .*Shopify's fulfillments couldn't be read/),
	]);
	expect(await shipped(C)).toEqual([null]);
});
