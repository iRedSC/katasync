import { beforeEach, describe, expect, test, vi } from "vitest";
import { ContentsChanged, Held } from "#/shipping/packed";
import { shopifyFulfill } from "./fulfillment";

type Item = { id: string; line: string; name: string; remaining: number };
type Done = { id: string; numbers: string[]; lines: [string, number][] };

// Shopify answering from these fulfillment orders (at location "W" unless
// named) and earlier fulfillments, one page each. Every call is kept.
function shopify(
	fos: { id: string; status: string; location?: string; items: Item[] }[],
	done: Done[] = [],
) {
	const calls: { query: string; variables: Record<string, unknown> }[] = [];
	const page = { hasNextPage: false, endCursor: null };
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		calls.push(body);
		const { id } = body.variables as { id: string };
		const data = body.query.startsWith("mutation")
			? {
					fulfillmentCreate: {
						fulfillment: { id: "gid://shopify/Fulfillment/7" },
						userErrors: [],
					},
				}
			: body.query.includes("on FulfillmentOrder")
				? {
						node: {
							lineItems: {
								pageInfo: page,
								nodes: (fos.find((f) => f.id === id)?.items ?? []).map((i) => ({
									id: i.id,
									remainingQuantity: i.remaining,
									lineItem: { id: i.line, name: i.name },
								})),
							},
						},
					}
				: body.query.includes("on Fulfillment")
					? {
							node: {
								fulfillmentLineItems: {
									pageInfo: page,
									nodes: (done.find((f) => f.id === id)?.lines ?? []).map(
										([line, quantity]) => ({
											quantity,
											lineItem: { id: line },
										}),
									),
								},
							},
						}
					: {
							order: {
								fulfillmentOrders: {
									pageInfo: page,
									nodes: fos.map((f) => ({
										id: f.id,
										status: f.status,
										assignedLocation: {
											name: f.location ?? "W",
											location: { id: f.location ?? "W" },
										},
									})),
								},
								fulfillments: done.map((f) => ({
									id: f.id,
									status: "SUCCESS",
									trackingInfo: f.numbers.map((number) => ({ number })),
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
	test("names each fulfillment order line's exact quantity, split across fulfillment orders at one location", async () => {
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
			"within",
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

	test("a whole order fulfills nothing when Shopify has more open than packed", async () => {
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
		const sent = shopifyFulfill("o", tracking, new Map([["L1", 2]]), "exactly");
		await expect(sent).rejects.toBeInstanceOf(ContentsChanged);
		await sent.catch((err: ContentsChanged) =>
			expect(err.drift).toEqual([
				{ line: "L9", title: "Added later", packed: 0, open: 1 },
			]),
		);
		expect(mutationOf(calls)).toBeUndefined();
	});

	test("one shipment of several fulfills just the box and says what's left", async () => {
		const calls = shopify([
			{
				id: "FO1",
				status: "OPEN",
				items: [
					{ id: "FOL1", line: "L1", name: "Wrench", remaining: 3 },
					{ id: "FOL2", line: "L2", name: "Knife", remaining: 1 },
				],
			},
		]);
		expect(
			await shopifyFulfill("o", tracking, new Map([["L1", 2]]), "within"),
		).toEqual({ fulfillmentId: "gid://shopify/Fulfillment/7", remaining: 2 });
		expect(mutationOf(calls)?.lineItemsByFulfillmentOrder).toEqual([
			{
				fulfillmentOrderId: "FO1",
				fulfillmentOrderLineItems: [{ id: "FOL1", quantity: 2 }],
			},
		]);
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
			shopifyFulfill("o", tracking, new Map([["L1", 2]]), "within"),
		).rejects.toBeInstanceOf(ContentsChanged);
		expect(mutationOf(calls)).toBeUndefined();
	});

	test("an unpacked line on hold doesn't block the box, and is still left to ship", async () => {
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
		expect(
			await shopifyFulfill("o", tracking, new Map([["L1", 2]]), "within"),
		).toEqual({ fulfillmentId: "gid://shopify/Fulfillment/7", remaining: 1 });
		expect(mutationOf(calls)?.lineItemsByFulfillmentOrder).toEqual([
			{
				fulfillmentOrderId: "FO1",
				fulfillmentOrderLineItems: [{ id: "FOL1", quantity: 2 }],
			},
		]);
		// A whole order still counts it.
		await expect(
			shopifyFulfill("o", tracking, new Map([["L1", 2]]), "exactly"),
		).rejects.toBeInstanceOf(ContentsChanged);
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
			shopifyFulfill("o", tracking, new Map([["L1", 2]]), "within"),
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
		expect(
			await shopifyFulfill("o", tracking, new Map([["L1", 2]]), "within"),
		).toEqual({ fulfillmentId: "F1", remaining: 1 });

		const calls = shopify(
			[open],
			[{ id: "F1", numbers: ["9400"], lines: [["L1", 1]] }],
		);
		// Even when the box fits within what's open, a retry never takes an
		// earlier fulfillment of other units for this one.
		const wrong = shopifyFulfill("o", tracking, new Map([["L1", 2]]), "within");
		await expect(wrong).rejects.toBeInstanceOf(Held);
		await expect(wrong).rejects.not.toBeInstanceOf(ContentsChanged);
		expect(mutationOf(calls)).toBeUndefined();
	});

	test("the 11th one-unit shipment of an 11-unit line goes out, and a retry finds it", async () => {
		const earlier: Done[] = Array.from({ length: 10 }, (_, n) => ({
			id: `F${n}`,
			numbers: [`T${n}`],
			lines: [["L1", 1]],
		}));
		const open = {
			id: "FO1",
			status: "OPEN",
			items: [{ id: "FOL1", line: "L1", name: "Wrench", remaining: 1 }],
		};
		const calls = shopify([open], earlier);
		expect(
			await shopifyFulfill("o", tracking, new Map([["L1", 1]]), "within"),
		).toEqual({ fulfillmentId: "gid://shopify/Fulfillment/7", remaining: 0 });
		expect(mutationOf(calls)?.lineItemsByFulfillmentOrder).toEqual([
			{
				fulfillmentOrderId: "FO1",
				fulfillmentOrderLineItems: [{ id: "FOL1", quantity: 1 }],
			},
		]);
		// It got through but wasn't recorded: the retry finds the 11th by its
		// tracking among them all and sends nothing more.
		const retry = shopify(
			[{ ...open, items: [{ ...open.items[0], remaining: 0 }] }],
			[...earlier, { id: "F10", numbers: ["9400"], lines: [["L1", 1]] }],
		);
		expect(
			await shopifyFulfill("o", tracking, new Map([["L1", 1]]), "within"),
		).toEqual({ fulfillmentId: "F10", remaining: 0 });
		expect(mutationOf(retry)).toBeUndefined();
	});

	test("a box only two locations together hold is held, not sent", async () => {
		const calls = shopify([
			{
				id: "FO1",
				status: "OPEN",
				location: "A",
				items: [{ id: "FOL1", line: "L1", name: "Wrench", remaining: 1 }],
			},
			{
				id: "FO2",
				status: "OPEN",
				location: "B",
				items: [{ id: "FOL2", line: "L2", name: "Knife", remaining: 1 }],
			},
		]);
		const sent = shopifyFulfill(
			"o",
			tracking,
			new Map([
				["L1", 1],
				["L2", 1],
			]),
			"within",
		);
		await expect(sent).rejects.toBeInstanceOf(Held);
		await expect(sent).rejects.toThrow("different Shopify locations");
		expect(mutationOf(calls)).toBeUndefined();
	});
});
