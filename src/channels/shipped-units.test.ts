import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { amazonItem, amazonOrder, amazonToChannelOrder } from "./amazon";
import {
	ebayOrder,
	ebayShipped,
	ebayShippedOf,
	ebayToChannelOrder,
} from "./ebay";
import { shopifyShipped } from "./shopify/channel-order";
import { shippedUnits } from "./shopify/fulfillment-units";
import { tiktokOrder, tiktokToChannelOrder } from "./tiktok";

// What each channel says already went out of every line, which decides what
// quick ship still packs (src/orders/remaining.ts).

const shippedOf = (o: {
	lines: { externalId: string; shipped: number | null }[];
}) => o.lines.map((l) => [l.externalId, l.shipped]);

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("Amazon", () => {
	const order = amazonOrder.assert({
		AmazonOrderId: "113-0000000-0000001",
		PurchaseDate: "2026-10-08T12:00:00Z",
		LastUpdateDate: "2026-10-08T13:00:00Z",
		OrderStatus: "PartiallyShipped",
		FulfillmentChannel: "MFN",
	});
	const item = (id: string, extra: Record<string, unknown>) =>
		amazonItem.assert({
			OrderItemId: id,
			Title: id,
			QuantityOrdered: 3,
			...extra,
		});

	test("passes QuantityShipped through, unknown when Amazon leaves it out", () => {
		const o = amazonToChannelOrder(order, [
			item("1", { QuantityShipped: 2 }),
			item("2", {}),
		]);
		expect(o.fulfillmentStatus).toBe("PARTIALLY_FULFILLED");
		expect(shippedOf(o)).toEqual([
			["1", 2],
			["2", null],
		]);
	});
});

describe("TikTok", () => {
	const unit = (
		id: string,
		display_status: string | undefined,
		sku = "1729",
	) => ({
		id,
		sku_id: sku,
		product_name: "Wrench",
		sale_price: "18.00",
		...(display_status ? { display_status } : {}),
	});
	const order = (status: string, units: ReturnType<typeof unit>[]) =>
		tiktokToChannelOrder(
			tiktokOrder.assert({
				id: "577",
				status,
				create_time: 1791460800,
				update_time: 1791464400,
				line_items: units,
			}),
		);

	test("counts each line's units TikTok shows gone, leaving cancelled ones out", () => {
		const o = order("PARTIALLY_SHIPPING", [
			unit("a", "IN_TRANSIT"),
			unit("b", "AWAITING_SHIPMENT"),
			unit("c", "DELIVERED"),
			unit("d", "CANCELLED"),
			unit("e", "AWAITING_SHIPMENT", "1730"),
		]);
		expect(o.lines.map((l) => [l.externalId, l.quantity, l.shipped])).toEqual([
			["1729", 3, 2],
			["1730", 1, 0],
		]);
	});

	test("a unit with no status makes its line unknown", () => {
		const o = order("PARTIALLY_SHIPPING", [
			unit("a", "IN_TRANSIT"),
			unit("b", undefined),
		]);
		expect(shippedOf(o)).toEqual([["1729", null]]);
	});
});

describe("Shopify", () => {
	const units = {
		sent: new Map([["L1", 3]]),
		succeeded: new Map([["L1", 2]]),
	};

	test("the status says it, except partly shipped, which counts successful fulfillments", () => {
		const of = (status: string, read: typeof units | null = units) =>
			shopifyShipped({ displayFulfillmentStatus: status }, "L1", 5, read);
		expect(of("UNFULFILLED")).toBe(0);
		expect(of("FULFILLED")).toBe(5);
		expect(of("PARTIALLY_FULFILLED")).toBe(2);
		expect(of("PARTIALLY_FULFILLED", null)).toBeNull();
		expect(
			shopifyShipped(
				{ displayFulfillmentStatus: "PARTIALLY_FULFILLED" },
				"L2",
				1,
				units,
			),
		).toBe(0);
	});

	describe("shippedUnits", () => {
		beforeEach(() => {
			vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example.com");
			vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
		});
		const reply = (
			fulfillments: {
				status: string;
				lines: [string, number][];
				more?: boolean;
			}[],
		) =>
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({
							data: {
								order: {
									fulfillments: fulfillments.map((f) => ({
										status: f.status,
										fulfillmentLineItems: {
											pageInfo: { hasNextPage: f.more ?? false },
											nodes: f.lines.map(([id, quantity]) => ({
												quantity,
												lineItem: { id },
											})),
										},
									})),
								},
							},
						}),
					),
			);

		test("counts only successful fulfillments as shipped, and every unfailed one as sent", async () => {
			reply([
				{ status: "SUCCESS", lines: [["L1", 1]] },
				{
					status: "SUCCESS",
					lines: [
						["L1", 1],
						["L2", 1],
					],
				},
				{ status: "OPEN", lines: [["L1", 1]] },
				{ status: "CANCELLED", lines: [["L1", 4]] },
			]);
			const units = await shippedUnits("gid://shopify/Order/1");
			expect(units?.succeeded).toEqual(
				new Map([
					["L1", 2],
					["L2", 1],
				]),
			);
			expect(units?.sent).toEqual(
				new Map([
					["L1", 3],
					["L2", 1],
				]),
			);
		});

		test("a fulfillment with more lines than one read returns is unknown", async () => {
			reply([{ status: "SUCCESS", lines: [["L1", 1]], more: true }]);
			expect(await shippedUnits("gid://shopify/Order/1")).toBeNull();
		});

		test("as many fulfillments as one read returns may not be all of them", async () => {
			reply(
				Array.from({ length: 50 }, () => ({
					status: "SUCCESS",
					lines: [["L1", 1]],
				})),
			);
			expect(await shippedUnits("gid://shopify/Order/1")).toBeNull();
		});
	});
});

describe("eBay", () => {
	const order = (status: string) =>
		ebayOrder.assert({
			orderId: "01-00000-00001",
			creationDate: "2026-10-08T12:00:00Z",
			lastModifiedDate: "2026-10-08T13:00:00Z",
			orderFulfillmentStatus: status,
			pricingSummary: { total: { value: "30.00" } },
			lineItems: [
				{
					lineItemId: "L1",
					title: "Blade",
					quantity: 3,
					lineItemCost: { value: "27.00" },
				},
				{
					lineItemId: "L2",
					title: "Knife",
					quantity: 1,
					lineItemCost: { value: "3.00" },
				},
			],
		});

	test("the order's status says it, except in progress, which counts its fulfillments", () => {
		expect(shippedOf(ebayToChannelOrder(order("NOT_STARTED"), null))).toEqual([
			["L1", 0],
			["L2", 0],
		]);
		expect(shippedOf(ebayToChannelOrder(order("FULFILLED"), null))).toEqual([
			["L1", 3],
			["L2", 1],
		]);
		expect(
			shippedOf(ebayToChannelOrder(order("IN_PROGRESS"), new Map([["L1", 2]]))),
		).toEqual([
			["L1", 2],
			["L2", 0],
		]);
		expect(shippedOf(ebayToChannelOrder(order("IN_PROGRESS"), null))).toEqual([
			["L1", null],
			["L2", null],
		]);
	});

	test("fulfillments count once each; one without its lines is unknown", () => {
		const f = {
			fulfillmentId: "F1",
			lineItems: [{ lineItemId: "L1", quantity: 1 }],
		};
		expect(
			ebayShipped([
				f,
				f,
				{ fulfillmentId: "F2", lineItems: [{ lineItemId: "L1", quantity: 1 }] },
			]),
		).toEqual(new Map([["L1", 2]]));
		expect(ebayShipped([f, { fulfillmentId: "F3" }])).toBeNull();
	});

	describe("ebayShippedOf", () => {
		beforeEach(() => {
			vi.stubEnv("EBAY_CLIENT_ID", "id");
			vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
			vi.stubEnv("EBAY_REFRESH_TOKEN", "refresh");
		});
		const ebay = (fulfillments: () => Response) => {
			const urls: string[] = [];
			vi.stubGlobal("fetch", async (url: string) => {
				urls.push(url);
				if (url.endsWith("/identity/v1/oauth2/token"))
					return new Response(
						JSON.stringify({ access_token: "t", expires_in: 7200 }),
					);
				return fulfillments();
			});
			return urls;
		};

		test("reads only an order in progress", async () => {
			const urls = ebay(
				() =>
					new Response(
						JSON.stringify({
							fulfillments: [
								{
									fulfillmentId: "F1",
									lineItems: [{ lineItemId: "L1", quantity: 2 }],
								},
							],
						}),
					),
			);
			expect(await ebayShippedOf(order("NOT_STARTED"))).toBeNull();
			expect(urls).toEqual([]);
			expect(await ebayShippedOf(order("IN_PROGRESS"))).toEqual(
				new Map([["L1", 2]]),
			);
		});

		test("eBay failing leaves the order unknown rather than stopping the sync", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			ebay(() => new Response("down", { status: 503 }));
			expect(await ebayShippedOf(order("IN_PROGRESS"))).toBeNull();
		});
	});
});
