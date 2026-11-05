import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	allocate,
	readShopifyOpen,
	type ShopifyOpen,
	SPLIT_LOCATIONS,
	shippableNow,
	TOO_MANY_SHIPMENTS,
	unitsOpen,
} from "./fulfillment-units";

const openUnits = async (id: string) =>
	unitsOpen((await shippableNow(id)).fulfillmentOrders);

// What quick ship reads from Shopify before planning and buying: units
// still to ship on fulfillment orders katasync may fulfill now.

type Page<T> = { nodes: T[]; next?: string | null };

// Shopify answering from these fulfillment orders, a page of items each
// unless split. Every query is kept.
function shopify(
	orders: Page<{ id: string; status: string; location?: string }>[],
	items: Record<string, Page<{ line: string; remaining: number }>[]>,
	shipments = 0,
) {
	const asked: string[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { variables } = JSON.parse(String(init.body)) as {
			variables: { id: string; cursor: string | null; first?: boolean };
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
									id: `${variables.id}/${n.line}`,
									remainingQuantity: n.remaining,
									lineItem: { id: n.line, name: n.line },
								})),
							},
						},
					};
				})()
			: (() => {
					const i = at(variables.cursor);
					return {
						order: {
							...(variables.first
								? {
										fulfillments: Array.from({ length: shipments }, (_, n) => ({
											id: `F${n}`,
											status: "SUCCESS",
											trackingInfo: [{ number: `T${n}` }],
										})),
									}
								: {}),
							fulfillmentOrders: {
								pageInfo: pageInfo(orders[i], i, orders),
								nodes: orders[i].nodes.map(({ location, ...f }) => ({
									...f,
									assignedLocation: {
										name: location ?? "Warehouse",
										location: { id: location ?? "Warehouse" },
									},
								})),
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

describe("readShopifyOpen", () => {
	test("keeps each fulfillment order's location and every shipment", async () => {
		shopify(
			[
				{
					nodes: [
						{ id: fo(1), status: "OPEN", location: "A" },
						{ id: fo(2), status: "OPEN", location: "B" },
					],
				},
			],
			{
				[fo(1)]: [{ nodes: [{ line: "L1", remaining: 1 }] }],
				[fo(2)]: [{ nodes: [{ line: "L1", remaining: 1 }] }],
			},
			3,
		);
		const read = await readShopifyOpen("gid://shopify/Order/1");
		expect(read.fulfillmentOrders.map((f) => f.location)).toEqual(["A", "B"]);
		expect(read.fulfillments).toHaveLength(3);
	});

	test("more shipments than one read returns says so", async () => {
		shopify([{ nodes: [] }], {}, 100);
		expect((await readShopifyOpen("o")).fulfillments).toBe("too many");
	});
});

describe("allocate", () => {
	const at = (...fos: [string, string, [string, number][]][]): ShopifyOpen => ({
		fulfillments: [],
		fulfillmentOrders: fos.map(([id, location, items]) => ({
			id,
			status: "OPEN",
			location,
			items: items.map(([line, remaining]) => ({
				id: `${id}/${line}`,
				line,
				name: line,
				remaining,
			})),
		})),
	});

	test("takes a box from the one location that holds it all", () => {
		const open = at(
			["FO1", "A", [["L1", 1]]],
			[
				"FO2",
				"B",
				[
					["L1", 2],
					["L2", 1],
				],
			],
		);
		const box = new Map([
			["L1", 2],
			["L2", 1],
		]);
		expect(allocate(open, box)).toEqual([
			{
				fulfillmentOrderId: "FO2",
				fulfillmentOrderLineItems: [
					{ id: "FO2/L1", quantity: 2 },
					{ id: "FO2/L2", quantity: 1 },
				],
			},
		]);
	});

	test("refuses a box only two locations together hold", () => {
		const open = at(["FO1", "A", [["L1", 1]]], ["FO2", "B", [["L2", 1]]]);
		const box = new Map([
			["L1", 1],
			["L2", 1],
		]);
		expect(() => allocate(open, box)).toThrow(SPLIT_LOCATIONS);
	});

	test("refuses unless every shipment can still be seen after this one", () => {
		const shipped = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				id: `F${i}`,
				status: "SUCCESS",
				numbers: [],
			}));
		const open = at(["FO1", "A", [["L1", 1]]]);
		const box = new Map([["L1", 1]]);
		expect(() => allocate({ ...open, fulfillments: "too many" }, box)).toThrow(
			TOO_MANY_SHIPMENTS,
		);
		expect(() => allocate({ ...open, fulfillments: shipped(99) }, box)).toThrow(
			TOO_MANY_SHIPMENTS,
		);
		expect(allocate({ ...open, fulfillments: shipped(98) }, box)).toHaveLength(
			1,
		);
	});
});
