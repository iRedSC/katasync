import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { ensureStore } from "../stores";
import { ingestMatching } from "./ingest";

// One sync pass over Shopify's orders, with Shopify faked by what each query
// asks for.

const money = (amount: string) => ({ shopMoney: { amount } });

const node = (
	id: string,
	displayFulfillmentStatus: string,
	line: { quantity: number; currentQuantity: number },
) => ({
	id,
	name: `#${id.split("/").pop()}`,
	sourceName: "web",
	tags: [],
	app: null,
	merchantOfRecordApp: null,
	channelInformation: null,
	createdAt: "2026-10-05T12:00:00Z",
	updatedAt: "2026-10-05T12:00:00Z",
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
				...line,
				variant: null,
				discountedUnitPriceAfterAllDiscountsSet: money("10.00"),
			},
		],
	},
});

const fulfillment = (lineId: string, quantity: number) => ({
	status: "SUCCESS",
	fulfillmentLineItems: {
		pageInfo: { hasNextPage: false },
		nodes: [{ quantity, lineItem: { id: lineId } }],
	},
});

// Order 1 is refunded and order 3 isn't, both with more fulfillments than
// one read holds; order 2 is on hold for what's left after one of its three
// units shipped.
const REFUNDED = "gid://shopify/Order/1";
const HELD = "gid://shopify/Order/2";
const PARTLY = "gid://shopify/Order/3";

const orders = [
	node(REFUNDED, "PARTIALLY_FULFILLED", { quantity: 3, currentQuantity: 2 }),
	node(HELD, "ON_HOLD", { quantity: 3, currentQuantity: 3 }),
	node(PARTLY, "PARTIALLY_FULFILLED", { quantity: 3, currentQuantity: 3 }),
];

const json = (data: unknown) => new Response(JSON.stringify({ data }));

// Shopify's answer to each order's fulfillment read, by order id.
function fakeShopify(shipped: (id: string) => Response) {
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { query, variables } = JSON.parse(String(init.body));
		if (query.includes("query Orders"))
			return json({
				orders: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: orders,
				},
			});
		if (query.includes("query Shipped")) return shipped(variables.id);
		return json({ nodes: [] });
	});
}

const tooMany = (id: string) =>
	json({
		order: {
			fulfillments: Array.from({ length: 50 }, () => fulfillment(`${id}/L`, 1)),
		},
	});

let db: Db;
beforeEach(async () => {
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example.com");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
	db = await createTestDb();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function sync() {
	const store = await ensureStore(db, "shopify", {
		id: "gid://shopify/Shop/1",
		name: "Shop",
	});
	const result = await ingestMatching(db, store, "", {
		shipping: null,
		store: null,
		pos: null,
		storeKeeps: 0,
	});
	const saved = await db
		.select({
			order: schema.orders.externalId,
			shipped: schema.orderLines.shippedQuantity,
		})
		.from(schema.orderLines)
		.innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
		.orderBy(schema.orders.externalId);
	return { ...result, saved };
}

test("an order whose fulfillments can't all be read is reported, and the pass goes on", async () => {
	fakeShopify((id) =>
		id === HELD
			? json({ order: { fulfillments: [fulfillment(`${HELD}/L`, 1)] } })
			: tooMany(id),
	);
	const { count, problems, saved } = await sync();
	expect(count).toBe(2);
	expect(problems).toEqual([
		expect.stringMatching(/^#1: has more .*refunds weren't synced/),
		expect.stringMatching(/^#3: has more .*left to ship is unknown/),
	]);
	// Shopify's hold is on what's left: the unit that shipped still counts.
	// The refunded order waits as it was; the other saves, shipped unknown.
	expect(saved).toEqual([
		{ order: HELD, shipped: 1 },
		{ order: PARTLY, shipped: null },
	]);
});

test.each([
	["HTTP", () => new Response("down", { status: 502 })],
	[
		"GraphQL",
		() => new Response(JSON.stringify({ errors: [{ message: "Throttled" }] })),
	],
	["an unexpected shape", () => json({ order: { fulfillments: "nope" } })],
])("a read failing with %s skips a refunded order, saves the rest unknown, and the pass goes on", async (_, reply) => {
	fakeShopify(reply);
	const { count, problems, saved } = await sync();
	expect(count).toBe(2);
	expect(problems).toEqual([
		expect.stringMatching(
			/^#1: Shopify's fulfillments couldn't be read .*refunds weren't synced/s,
		),
		expect.stringMatching(
			/^#2: Shopify's fulfillments couldn't be read .*left to ship is unknown/s,
		),
		expect.stringMatching(
			/^#3: Shopify's fulfillments couldn't be read .*left to ship is unknown/s,
		),
	]);
	expect(saved).toEqual([
		{ order: HELD, shipped: null },
		{ order: PARTLY, shipped: null },
	]);
});
