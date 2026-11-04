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

// Order 1 is refunded with more fulfillments than one read holds; order 2
// is on hold for what's left after one of its three units shipped.
const REFUNDED = "gid://shopify/Order/1";
const HELD = "gid://shopify/Order/2";

function fakeShopify() {
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { query, variables } = JSON.parse(String(init.body));
		const data = query.includes("query Orders")
			? {
					orders: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							node(REFUNDED, "PARTIALLY_FULFILLED", {
								quantity: 3,
								currentQuantity: 2,
							}),
							node(HELD, "ON_HOLD", { quantity: 3, currentQuantity: 3 }),
						],
					},
				}
			: query.includes("query Shipped")
				? {
						order: {
							fulfillments:
								variables.id === REFUNDED
									? Array.from({ length: 50 }, () =>
											fulfillment(`${REFUNDED}/L`, 1),
										)
									: [fulfillment(`${HELD}/L`, 1)],
						},
					}
				: { nodes: [] };
		return new Response(JSON.stringify({ data }));
	});
}

let db: Db;
beforeEach(async () => {
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example.com");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
	db = await createTestDb();
	fakeShopify();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

test("an order whose fulfillments can't all be read is reported, and the pass goes on", async () => {
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
	expect(result.count).toBe(1);
	expect(result.problems).toEqual([
		expect.stringMatching(/^#1: .*refunds weren't synced/),
	]);
	const saved = await db
		.select({
			order: schema.orders.externalId,
			shipped: schema.orderLines.shippedQuantity,
		})
		.from(schema.orderLines)
		.innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId));
	// Shopify's hold is on what's left: the unit that shipped still counts.
	expect(saved).toEqual([{ order: HELD, shipped: 1 }]);
});
