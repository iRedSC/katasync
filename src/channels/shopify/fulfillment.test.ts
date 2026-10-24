import { beforeEach, describe, expect, test, vi } from "vitest";
import { ContentsChanged, Held } from "#/shipping/packed";
import { shopifyFulfill } from "./fulfillment";

type Item = { id: string; line: string; name: string; remaining: number };
type Done = { id: string; numbers: string[]; lines: [string, number][] };

function shopify(
	fos: { id: string; status: string; items: Item[] }[],
	done: Done[] = [],
) {
	const calls: { query: string; variables: Record<string, unknown> }[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		calls.push(body);
		const data = body.query.startsWith("mutation")
			? {
					fulfillmentCreate: {
						fulfillment: { id: "gid://shopify/Fulfillment/7" },
						userErrors: [],
					},
				}
			: {
					order: {
						fulfillmentOrders: {
							pageInfo: { hasNextPage: false },
							nodes: fos.map((f) => ({
								id: f.id,
								status: f.status,
								lineItems: {
									pageInfo: { hasNextPage: false },
									nodes: f.items.map((i) => ({
										id: i.id,
										remainingQuantity: i.remaining,
										lineItem: { id: i.line, name: i.name },
									})),
								},
							})),
						},
						fulfillments: done.map((f) => ({
							id: f.id,
							status: "SUCCESS",
							trackingInfo: f.numbers.map((number) => ({ number })),
							fulfillmentLineItems: {
								pageInfo: { hasNextPage: false },
								nodes: f.lines.map(([id, quantity]) => ({
									quantity,
									lineItem: { id },
								})),
							},
						})),
					},
				};
		return new Response(JSON.stringify({ data }));
	});
	return calls;
}

const tracking = { company: "USPS", boxes: [{ number: "9400", url: null }] };
const mutationOf = (calls: ReturnType<typeof shopify>) =>
	calls.find((c) => c.query.startsWith("mutation"))?.variables.fulfillment as
		| { lineItemsByFulfillmentOrder: unknown }
		| undefined;

beforeEach(() => {
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example.com");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
});

describe("shopifyFulfill", () => {
	test("names each fulfillment order line's exact quantity, split across locations", async () => {
		const calls = shopify([
			{
				id: "FO1",
				status: "OPEN",
				items: [
					{ id: "FOL1", line: "L1", name: "Wrench", remaining: 1 },
					{ id: "FOL2", line: "L2", name: "Knife", remaining: 1 },
				],
			},
			{
				id: "FO2",
				status: "OPEN",
				items: [{ id: "FOL3", line: "L1", name: "Wrench", remaining: 2 }],
			},
		]);
		const result = await shopifyFulfill(
			"gid://shopify/Order/1",
			tracking,
			new Map([
				["L1", 3],
				["L2", 1],
			]),
		);
		expect(result).toEqual({
			fulfillmentId: "gid://shopify/Fulfillment/7",
			remaining: 0,
		});
		expect(mutationOf(calls)?.lineItemsByFulfillmentOrder).toEqual([
			{
				fulfillmentOrderId: "FO1",
				fulfillmentOrderLineItems: [
					{ id: "FOL1", quantity: 1 },
					{ id: "FOL2", quantity: 1 },
				],
			},
			{
				fulfillmentOrderId: "FO2",
				fulfillmentOrderLineItems: [{ id: "FOL3", quantity: 2 }],
			},
		]);
	});

	test("more open on Shopify than was packed fulfills nothing", async () => {
		const calls = shopify([
			{
				id: "FO1",
				status: "OPEN",
				items: [
					{ id: "FOL1", line: "L1", name: "Wrench", remaining: 2 },
					{ id: "FOL2", line: "L9", name: "Added later", remaining: 1 },
				],
			},
		]);
		const sent = shopifyFulfill("o", tracking, new Map([["L1", 2]]));
		await expect(sent).rejects.toBeInstanceOf(ContentsChanged);
		await sent.catch((err: ContentsChanged) =>
			expect(err.drift).toEqual([
				{ line: "L9", title: "Added later", packed: 0, open: 1 },
			]),
		);
		expect(mutationOf(calls)).toBeUndefined();
	});

	test("less open than packed fulfills nothing", async () => {
		const calls = shopify([
			{
				id: "FO1",
				status: "OPEN",
				items: [{ id: "FOL1", line: "L1", name: "Wrench", remaining: 1 }],
			},
		]);
		await expect(
			shopifyFulfill("o", tracking, new Map([["L1", 2]])),
		).rejects.toBeInstanceOf(ContentsChanged);
		expect(mutationOf(calls)).toBeUndefined();
	});

	test("an unpacked line on hold still counts as left to ship", async () => {
		const calls = shopify([
			{
				id: "FO1",
				status: "OPEN",
				items: [{ id: "FOL1", line: "L1", name: "Wrench", remaining: 2 }],
			},
			{
				id: "FO2",
				status: "ON_HOLD",
				items: [{ id: "FOL2", line: "L2", name: "Knife", remaining: 1 }],
			},
		]);
		await expect(
			shopifyFulfill("o", tracking, new Map([["L1", 2]])),
		).rejects.toBeInstanceOf(ContentsChanged);
		expect(mutationOf(calls)).toBeUndefined();
	});

	test("packed items on hold are held, not partly fulfilled", async () => {
		const calls = shopify([
			{
				id: "FO1",
				status: "ON_HOLD",
				items: [{ id: "FOL1", line: "L1", name: "Wrench", remaining: 2 }],
			},
		]);
		await expect(
			shopifyFulfill("o", tracking, new Map([["L1", 2]])),
		).rejects.toThrow("on hold");
		expect(mutationOf(calls)).toBeUndefined();
	});

	test("an earlier fulfillment with this tracking is taken only if it shipped exactly the box", async () => {
		const open = {
			id: "FO1",
			status: "OPEN",
			items: [{ id: "FOL2", line: "L2", name: "Knife", remaining: 1 }],
		};
		shopify([open], [{ id: "F1", numbers: ["9400"], lines: [["L1", 2]] }]);
		expect(await shopifyFulfill("o", tracking, new Map([["L1", 2]]))).toEqual({
			fulfillmentId: "F1",
			remaining: 1,
		});

		const calls = shopify(
			[open],
			[{ id: "F1", numbers: ["9400"], lines: [["L1", 1]] }],
		);
		const wrong = shopifyFulfill("o", tracking, new Map([["L1", 2]]));
		await expect(wrong).rejects.toBeInstanceOf(Held);
		await expect(wrong).rejects.not.toBeInstanceOf(ContentsChanged);
		expect(mutationOf(calls)).toBeUndefined();
	});
});
