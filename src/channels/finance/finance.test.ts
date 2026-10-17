import { describe, expect, test } from "vitest";
import { type AmazonTransaction, amazonCharges } from "./amazon";
import { type EbayTransaction, ebayCharges } from "./ebay";
import {
	labelsFromEvents,
	numericOrderId,
	type ShopifyFinanceOrder,
	shippedWithoutLabel,
	shippingLabelsQuery,
	shopifyCharges,
} from "./shopify";
import { type TiktokSkuTransaction, tiktokCharges } from "./tiktok";

// Shapes as the marketplaces answered for real orders in October 2026.

const total = (charges: { amount: number }[]) =>
	Math.round(charges.reduce((s, c) => s + c.amount, 0) * 100) / 100;

describe("eBay", () => {
	const usd = (value: string) => ({ value: Number(value) });
	const sale: EbayTransaction = {
		transactionType: "SALE",
		bookingEntry: "CREDIT",
		amount: usd("56.68"),
		totalFeeAmount: usd("9.47"),
		orderLineItems: [
			{
				marketplaceFees: [
					{ feeType: "FINAL_VALUE_FEE_FIXED_PER_ORDER", amount: usd("0.4") },
					{ feeType: "FINAL_VALUE_FEE", amount: usd("9.07") },
				],
			},
		],
	};
	const label: EbayTransaction = {
		transactionType: "SHIPPING_LABEL",
		bookingEntry: "DEBIT",
		amount: usd("5.83"),
		transactionMemo: "Shipping label purchased",
	};

	test("takes the sale's fees, labels, and ad fees, not the sale itself", () => {
		const ad: EbayTransaction = {
			transactionType: "NON_SALE_CHARGE",
			bookingEntry: "DEBIT",
			amount: usd("2.14"),
			transactionMemo: "Promoted Listings - General fee",
		};
		expect(ebayCharges([label, ad, sale])).toEqual([
			{ kind: "label", description: "eBay shipping label", amount: 5.83 },
			{
				kind: "fee",
				description: "Promoted Listings - General fee",
				amount: 2.14,
			},
			{
				kind: "fee",
				description: "Final value fee fixed per order",
				amount: 0.4,
			},
			{ kind: "fee", description: "Final value fee", amount: 9.07 },
		]);
	});

	test("a voided label and a refund net out by their booking entry", () => {
		const voided: EbayTransaction = { ...label, bookingEntry: "CREDIT" };
		const refund: EbayTransaction = {
			...sale,
			transactionType: "REFUND",
			bookingEntry: "DEBIT",
		};
		const charges = ebayCharges([label, voided, sale, refund]);
		expect(
			charges.filter((c) => c.kind === "label").map((c) => c.amount),
		).toEqual([5.83, -5.83]);
		expect(charges).toContainEqual({
			kind: "refund",
			description: "Refund",
			amount: 66.15,
		});
		// The fees came back with the refund: what's lost is the whole
		// sale, which the order's revenue offsets.
		expect(total(charges)).toBe(66.15);
	});

	test("leaves payouts out", () => {
		expect(
			ebayCharges([
				{ transactionType: "PAYOUT", bookingEntry: "DEBIT", amount: usd("50") },
			]),
		).toEqual([]);
	});
});

describe("Amazon", () => {
	const amount = (currencyAmount: number) => ({ currencyAmount });
	const shipment = (status: string, ids: [string, string][] = []) =>
		({
			transactionType: "Shipment",
			transactionStatus: status,
			relatedIdentifiers: ids.map(([n, v]) => ({
				relatedIdentifierName: n,
				relatedIdentifierValue: v,
			})),
			breakdowns: [
				{
					breakdownType: "Sales",
					breakdownAmount: amount(22.31),
					breakdowns: [],
				},
				{
					breakdownType: "Expenses",
					breakdownAmount: amount(-7.7),
					breakdowns: [
						{
							breakdownType: "AmazonFees",
							breakdownAmount: amount(-7.7),
							breakdowns: [
								{
									breakdownType: "FBAPerUnitFulfillmentFee",
									breakdownAmount: amount(-4.35),
									breakdowns: [
										{ breakdownType: "Base", breakdownAmount: amount(-4.35) },
									],
								},
								{ breakdownType: "Commission", breakdownAmount: amount(-3.35) },
							],
						},
					],
				},
			],
		}) as AmazonTransaction;

	test("counts a held-back shipment once, not again as its released copy", () => {
		const charges = amazonCharges([
			shipment("RELEASED", [["DEFERRED_TRANSACTION_ID", "x"]]),
			shipment("DEFERRED_RELEASED", [["RELEASE_TRANSACTION_ID", "y"]]),
		]);
		expect(charges).toEqual([
			{ kind: "fee", description: "FBAPerUnitFulfillmentFee", amount: 4.35 },
			{ kind: "fee", description: "Commission", amount: 3.35 },
		]);
	});

	test("labels bought through Amazon, and refunds", () => {
		const postage = {
			transactionType: "Adjustment",
			breakdowns: [
				{ breakdownType: "Sales", breakdownAmount: amount(0) },
				{
					breakdownType: "Expenses",
					breakdownAmount: amount(-7.23),
					breakdowns: [
						{
							breakdownType: "ShippingServiceCharges",
							breakdownAmount: amount(-7.23),
							breakdowns: [
								{
									breakdownType: "PostageBilling_Postage",
									breakdownAmount: amount(-7.23),
								},
							],
						},
					],
				},
			],
		} as AmazonTransaction;
		const refund = {
			transactionType: "Refund",
			breakdowns: [
				{ breakdownType: "Sales", breakdownAmount: amount(-22.31) },
				{
					breakdownType: "Expenses",
					breakdownAmount: amount(2.68),
					breakdowns: [
						{
							breakdownType: "AmazonFees",
							breakdownAmount: amount(2.68),
							breakdowns: [
								{ breakdownType: "Commission", breakdownAmount: amount(2.68) },
							],
						},
					],
				},
			],
		} as AmazonTransaction;
		expect(amazonCharges([postage, refund])).toEqual([
			{ kind: "label", description: "PostageBilling_Postage", amount: 7.23 },
			{ kind: "refund", description: "Refund", amount: 22.31 },
			{ kind: "fee", description: "Commission", amount: -2.68 },
		]);
	});
});

describe("TikTok", () => {
	const row: TiktokSkuTransaction = {
		fee_tax_amount: -3.59,
		fee_tax_breakdown: {
			fee: {
				referral_fee_amount: "-1.96",
				smart_promotion_fee_amount: "-1.14",
				campaign_period_fee_sp_amount: "-0.49",
				affiliate_commission_amount_before_pit: "-9",
				transaction_fee_amount: "0",
			},
			tax: { sales_tax_referral_fee_amount: "0" },
		},
		shipping_cost_amount: -3.28,
		shipping_cost_breakdown: {
			actual_shipping_fee_amount: "-11.12",
			customer_paid_shipping_fee_amount: "7.84",
			supplementary_component: { fbm_shipping_cost_amount: "-11.12" },
		},
		revenue_breakdown: {
			subtotal_before_discount_amount: "24.87",
			refund_subtotal_before_discount_amount: "0",
		},
	};

	test("fees and the label TikTok bought, without the buyer's shipping", () => {
		expect(tiktokCharges([row])).toEqual([
			{ kind: "fee", description: "Referral fee", amount: 1.96 },
			{ kind: "fee", description: "Smart promotion fee", amount: 1.14 },
			{ kind: "fee", description: "Campaign period fee sp", amount: 0.49 },
			{ kind: "label", description: "Actual shipping fee", amount: 11.12 },
		]);
	});

	test("keeps whatever the named entries miss, so totals match TikTok's", () => {
		const charges = tiktokCharges([{ ...row, fee_tax_amount: -4 }]);
		expect(charges).toContainEqual({
			kind: "fee",
			description: "Other TikTok fees",
			amount: expect.closeTo(0.41),
		});
		expect(total(charges.filter((c) => c.kind === "fee"))).toBe(4);
	});

	test("refunds", () => {
		const refunded = tiktokCharges([
			{
				...row,
				revenue_breakdown: { refund_subtotal_before_discount_amount: "-24.87" },
			},
		]);
		expect(refunded).toContainEqual({
			kind: "refund",
			description: "Refund subtotal before discount",
			amount: 24.87,
		});
	});
});

describe("Shopify", () => {
	const order = (
		overrides: Partial<ShopifyFinanceOrder> = {},
	): ShopifyFinanceOrder => ({
		id: "gid://shopify/Order/7633729060927",
		transactions: [
			{ kind: "AUTHORIZATION", status: "SUCCESS", fees: [] },
			{
				kind: "CAPTURE",
				status: "SUCCESS",
				fees: [{ type: "processing_fee", amount: { amount: 1.09 } }],
			},
		],
		refunds: [],
		events: {
			nodes: [
				{
					action: "shipping_label_created_success",
					message:
						"Darrick Trout purchased a $5.72 shipping label and the included shipping insurance premium.",
				},
			],
		},
		fulfillmentOrders: {
			nodes: [{ deliveryMethod: { methodType: "SHIPPING" } }],
		},
		...overrides,
	});

	test("ShopifyQL's label cost wins once it has the order", () => {
		expect(shopifyCharges(order(), 5.5)).toEqual([
			{ kind: "fee", description: "Processing fee", amount: 1.09 },
			{ kind: "label", description: "Shopify Shipping labels", amount: 5.5 },
		]);
	});

	test("until then the order's label purchases stand in", () => {
		expect(shopifyCharges(order(), undefined)).toContainEqual({
			kind: "label",
			description: "Shopify Shipping labels (until Shopify reports them)",
			amount: 5.72,
		});
		expect(
			labelsFromEvents([
				{
					action: "shipping_label_created_success",
					message: "x purchased a $1,005.10 shipping label",
				},
				{ action: "mail_sent", message: "purchased a $3.00 shipping label" },
			]),
		).toBe(1005.1);
	});

	test("refunds leave out the tax Shopify returns for us", () => {
		const refunded = order({
			refunds: [
				{
					refundLineItems: {
						nodes: [{ subtotalSet: { shopMoney: { amount: 20 } } }],
					},
					refundShippingLines: {
						nodes: [{ subtotalAmountSet: { shopMoney: { amount: 5.5 } } }],
					},
				},
			],
		});
		expect(shopifyCharges(refunded, 0)).toContainEqual({
			kind: "refund",
			description: "Refund",
			amount: 25.5,
		});
	});

	test("counter sales and pickups need no label", () => {
		const at = (methodType: string) =>
			order({
				fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType } }] },
			});
		expect(shippedWithoutLabel(at("RETAIL"))).toBe(true);
		expect(shippedWithoutLabel(at("PICK_UP"))).toBe(true);
		expect(shippedWithoutLabel(at("SHIPPING"))).toBe(false);
		expect(
			shippedWithoutLabel(order({ fulfillmentOrders: { nodes: [] } })),
		).toBe(false);
	});

	test("only digit order IDs reach ShopifyQL", () => {
		expect(
			shippingLabelsQuery(
				["gid://shopify/Order/123", "456"],
				new Date("2026-10-05T12:00:00Z"),
			),
		).toBe(
			"FROM shipping_labels SHOW shipping_label_costs WHERE order_id IN (123, 456) GROUP BY order_id SINCE 2026-10-03 UNTIL today ORDER BY order_id ASC LIMIT 2",
		);
		expect(() => numericOrderId("123) OR TRUE")).toThrow(
			"Not a Shopify order ID",
		);
	});
});
