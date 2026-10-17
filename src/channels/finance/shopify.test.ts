import { describe, expect, it } from "vitest";
import {
	applyShippingLabelEvents,
	buildShopifyFeesQuery,
	buildShopifyProfitabilityQuery,
	buildShopifyShippingLabelsQuery,
	isShopifyPickupOrder,
	mergeShopifyFinancialRows,
	shippingLabelCostFromEvents,
	shopifyQlDateWindow,
} from "./shopify";

describe("ShopifyQL financial contracts", () => {
	it("targets one or more numeric Shopify order IDs", () => {
		const query = buildShopifyFeesQuery({
			orderIds: ["gid://shopify/Order/123", "456", "gid://shopify/Order/123"],
		});

		expect(query).toContain("WHERE order_id IN (123, 456)");
		expect(query).toContain("GROUP BY order_id");
		expect(query).toContain("SINCE 2006-01-01 UNTIL today");
		expect(query).toContain("LIMIT 2");
		expect(query).not.toContain("OFFSET");
	});

	it("pages bulk queries in small windows", () => {
		const query = buildShopifyProfitabilityQuery({
			startDate: "2026-07-01",
			endDate: "2026-07-31",
			offset: 50,
		});

		expect(query).toContain("LIMIT 50 OFFSET 50");
		expect(query).not.toContain("LIMIT 1000");
	});

	it("rejects order IDs before interpolating them into ShopifyQL", () => {
		expect(() =>
			buildShopifyProfitabilityQuery({ orderIds: ["123) OR TRUE"] }),
		).toThrow("Invalid Shopify order ID");
	});

	it("builds bounded date queries for bulk sync", () => {
		const query = buildShopifyProfitabilityQuery({
			startDate: "2026-07-01",
			endDate: "2026-07-31",
		});

		expect(query).toContain("SINCE 2026-07-01 UNTIL 2026-07-31");
		expect(query).toContain("average_store_shipping_costs");
		expect(query).toContain("average_shipping_label_adjustment_costs");
		expect(query).toContain("average_customer_shipping_charges");
	});

	it("merges shipping and every fee component by order", () => {
		expect(
			mergeShopifyFinancialRows(
				[
					{
						order_id: "123",
						average_store_shipping_costs: "14.25",
						average_shipping_label_adjustment_costs: "2.25",
						average_customer_shipping_charges: "5.00",
					},
				],
				[
					{
						order_id: "123",
						shopify_payments_processing_fees: "3.10",
						foreign_exchange_fees: "0.40",
						managed_markets_fees: "1.20",
						international_fees: "1.60",
					},
				],
			),
		).toEqual([
			{
				orderId: "123",
				storeShippingCost: 14.25,
				shippingLabelAdjustment: 2.25,
				customerShippingCharges: 5,
				shopifyPaymentsProcessingFees: 3.1,
				foreignExchangeFees: 0.4,
				managedMarketsFees: 1.2,
				internationalFees: 1.6,
			},
		]);
	});

	it("keeps orders that appear in only one ShopifyQL dataset", () => {
		const result = mergeShopifyFinancialRows(
			[
				{
					order_id: "gid://shopify/Order/123",
					average_store_shipping_costs: "8",
				},
			],
			[{ order_id: 456, shopify_payments_processing_fees: "2" }],
		);

		expect(result.map(({ orderId }) => orderId)).toEqual(["123", "456"]);
	});

	it("queries purchased shipping label costs by order", () => {
		const query = buildShopifyShippingLabelsQuery({
			orderIds: ["gid://shopify/Order/123"],
		});

		expect(query).toContain("FROM shipping_labels");
		expect(query).toContain("shipping_label_costs");
		expect(query).toContain("WHERE order_id IN (123)");
		expect(query).toContain("LIMIT 1");
		expect(query).not.toContain("OFFSET");
	});

	it("uses shipping label costs when profitability shipping is zero", () => {
		expect(
			mergeShopifyFinancialRows(
				[
					{
						order_id: "123",
						average_store_shipping_costs: "0",
						average_shipping_label_adjustment_costs: "2.25",
						average_customer_shipping_charges: "5.00",
					},
				],
				[{ order_id: "123", shopify_payments_processing_fees: "3.10" }],
				[{ order_id: "123", shipping_label_costs: "12.00" }],
			),
		).toEqual([
			{
				orderId: "123",
				storeShippingCost: 14.25,
				shippingLabelAdjustment: 2.25,
				customerShippingCharges: 5,
				shopifyPaymentsProcessingFees: 3.1,
				foreignExchangeFees: 0,
				managedMarketsFees: 0,
				internationalFees: 0,
			},
		]);
	});

	it("pads ShopifyQL windows so overnight UTC orders still match shop-local sale days", () => {
		expect(
			shopifyQlDateWindow(
				Date.parse("2026-08-20T01:53:31Z"),
				Date.parse("2026-08-20T19:30:00Z"),
			),
		).toEqual({
			startDate: "2026-08-18",
			endDate: "2026-08-22",
		});
	});
});

describe("Shopify shipping label events", () => {
	const labelPurchased = (amount: string) => ({
		action: "shipping_label_created_success",
		message: `Darrick Trout purchased a $${amount} shipping label and the included shipping insurance premium.`,
	});

	it("sums purchased shipping label amounts from order events", () => {
		expect(
			shippingLabelCostFromEvents([
				{
					action: "placed",
					message: "David Croff placed this order on Online Store.",
				},
				labelPurchased("29.75"),
				labelPurchased("29.75"),
			]),
		).toBe(59.5);
	});

	it("uses event label costs when ShopifyQL shipping is still zero", () => {
		expect(
			applyShippingLabelEvents(
				{
					orderId: "7490736750655",
					storeShippingCost: 0,
					shippingLabelAdjustment: 0,
					customerShippingCharges: 43.55,
					shopifyPaymentsProcessingFees: 5.53,
					foreignExchangeFees: 0,
					managedMarketsFees: 0,
					internationalFees: 0,
				},
				[labelPurchased("29.75"), labelPurchased("29.75")],
			).storeShippingCost,
		).toBe(59.5);
	});
});

describe("Shopify pickup orders", () => {
	it("treats an order as pickup only when every fulfillment is pickup", () => {
		expect(
			isShopifyPickupOrder({
				fulfillmentOrders: {
					nodes: [{ deliveryMethod: { methodType: "PICK_UP" } }],
				},
			}),
		).toBe(true);
		expect(
			isShopifyPickupOrder({
				fulfillmentOrders: {
					nodes: [{ deliveryMethod: { methodType: "pick-up" } }],
				},
			}),
		).toBe(true);
		expect(
			isShopifyPickupOrder({
				fulfillmentOrders: {
					nodes: [
						{ deliveryMethod: { methodType: "PICK_UP" } },
						{ deliveryMethod: { methodType: "SHIPPING" } },
					],
				},
			}),
		).toBe(false);
		expect(
			isShopifyPickupOrder({
				fulfillmentOrders: {
					nodes: [{ deliveryMethod: { methodType: "PICKUP_POINT" } }],
				},
			}),
		).toBe(false);
		expect(
			isShopifyPickupOrder({
				fulfillmentOrders: {
					nodes: [{ deliveryMethod: { methodType: "SHIPPING" } }],
				},
			}),
		).toBe(false);
		expect(isShopifyPickupOrder({})).toBe(false);
		expect(
			isShopifyPickupOrder({
				shippingLines: {
					nodes: [{ title: "Pickup", code: "pickup" }],
				},
			}),
		).toBe(true);
		expect(
			isShopifyPickupOrder({
				fulfillmentOrders: {
					nodes: [{ deliveryMethod: { methodType: "SHIPPING" } }],
				},
				shippingLines: {
					nodes: [{ title: "Pickup" }],
				},
			}),
		).toBe(false);
	});
});
