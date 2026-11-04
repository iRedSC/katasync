import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openUnits } from "./fulfillment-units";

// What quick ship reads from Shopify before planning and buying: units
// still to ship on fulfillment orders katasync may fulfill now.

type Page<T> = { nodes: T[]; next?: string | null };

// Shopify answering from these fulfillment orders, a page of items each
// unless split. Every query is kept.
function shopify(
	orders: Page<{ id: string; status: string }>[],
	items: Record<string, Page<{ line: string; remaining: number }>[]>,
) {
	const asked: string[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { variables } = JSON.parse(String(init.body)) as {
			variables: { id: string; cursor: string | null };
		};
		asked.push(variables.id);
		const at = (cursor: string | null) => (cursor ? Number(cursor) : 0);
		const pageInfo = (page: Page<unknown>, i: number, all: unknown[]) => ({
			hasNextPage: i + 1 < all.length,
			endCursor: page.next === undefined ? String(i + 1) : page.next,
		});
		const data = variables.id.includes("FulfillmentOrder")
			? (() => {
					const pages = items[variables.id];
					const i = at(variables.cursor);
					return {
						node: {
							lineItems: {
								pageInfo: pageInfo(pages[i], i, pages),
								nodes: pages[i].nodes.map((n) => ({
									remainingQuantity: n.remaining,
									lineItem: { id: n.line },
								})),
							},
						},
					};
				})()
			: (() => {
					const i = at(variables.cursor);
					return {
						order: {
							fulfillmentOrders: {
								pageInfo: pageInfo(orders[i], i, orders),
								nodes: orders[i].nodes,
							},
						},
					};
				})();
		return new Response(JSON.stringify({ data }));
	});
	return asked;
}

const fo = (n: number) => `gid://shopify/FulfillmentOrder/${n}`;

beforeEach(() => {
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example.com");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("openUnits", () => {
	test("sums open and in-progress units across pages, leaving held and scheduled ones", async () => {
		const asked = shopify(
			[
				{
					nodes: [
						{ id: fo(1), status: "OPEN" },
						{ id: fo(2), status: "ON_HOLD" },
					],
				},
				{
					nodes: [
						{ id: fo(3), status: "IN_PROGRESS" },
						{ id: fo(4), status: "SCHEDULED" },
						{ id: fo(5), status: "CLOSED" },
					],
				},
			],
			{
				[fo(1)]: [
					{ nodes: [{ line: "L1", remaining: 2 }] },
					{ nodes: [{ line: "L2", remaining: 1 }] },
				],
				[fo(3)]: [{ nodes: [{ line: "L1", remaining: 1 }] }],
			},
		);
		expect(await openUnits("gid://shopify/Order/1")).toEqual(
			new Map([
				["L1", 3],
				["L2", 1],
			]),
		);
		// Held, scheduled and closed fulfillment orders aren't read at all.
		expect(asked.filter((id) => id === fo(2) || id === fo(4))).toEqual([]);
	});

	test("a page that says there's more but not where fails the read", async () => {
		shopify([{ nodes: [{ id: fo(1), status: "OPEN" }] }], {
			[fo(1)]: [
				{ nodes: [{ line: "L1", remaining: 2 }], next: null },
				{ nodes: [{ line: "L1", remaining: 5 }] },
			],
		});
		await expect(openUnits("gid://shopify/Order/1")).rejects.toThrow(
			"remaining-items cursor",
		);
	});

	test("an order Shopify doesn't return fails the read", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(JSON.stringify({ data: { order: null } })),
		);
		await expect(openUnits("gid://shopify/Order/1")).rejects.toThrow();
	});
});
