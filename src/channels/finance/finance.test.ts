import { describe, expect, test } from "vitest";
import {
	type AmazonTransaction,
	amazonCharges,
	amazonTransaction,
} from "./amazon";
import { type EbayTransaction, ebayCharges } from "./ebay";
import {
	cutShort,
	labelsFromEvents,
	numericOrderId,
	refundedRevenue,
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

	test("leaves out promotions, already off the order's prices", () => {
		const promoted = shipment("RELEASED");
		const expenses = promoted.breakdowns?.[1];
		expenses?.breakdowns?.push({
			breakdownType: "PromoRebates",
			breakdownAmount: amount(-2.5),
		});
		expect(amazonCharges([promoted]).map((c) => c.description)).not.toContain(
			"PromoRebates",
		);
	});

	test("a refund's promotion comes back to us, so the buyer got less", () => {
		const refund = {
			transactionType: "Refund",
			breakdowns: [
				{
					breakdownType: "Refunded Sales",
					breakdownAmount: amount(-100),
					breakdowns: [
						{ breakdownType: "ProductCharges", breakdownAmount: amount(-100) },
					],
				},
				{
					breakdownType: "Refunded Expenses",
					breakdownAmount: amount(20),
					breakdowns: [
						{ breakdownType: "PromoRebates", breakdownAmount: amount(20) },
					],
				},
			],
		} as AmazonTransaction;
		const refunded = amazonCharges([refund])
			.filter((c) => c.kind === "refund")
			.reduce((sum, c) => sum + c.amount, 0);
		expect(refunded).toBe(80);
	});

	test("a nested amount that isn't a number fails the order", () => {
		const bad = shipment("RELEASED") as unknown as {
			breakdowns: {
				breakdowns: { breakdowns: { breakdownAmount: unknown }[] }[];
			}[];
		};
		// The Base under FBAPerUnitFulfillmentFee, three levels down.
		bad.breakdowns[1].breakdowns[0].breakdowns[0].breakdownAmount = {
			currencyAmount: null,
		};
		expect(() => amazonTransaction.assert(bad)).toThrow();
	});

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
		// As Amazon answered for a real refund: its own headings, and the
		// return label it billed, then covered.
		const refund = {
			transactionType: "Refund",
			breakdowns: [
				{
					breakdownType: "Refunded Expenses",
					breakdownAmount: amount(11.09),
					breakdowns: [
						{ breakdownType: "AmazonFees", breakdownAmount: amount(4.44) },
						{ breakdownType: "Other", breakdownAmount: amount(6.65) },
					],
				},
				{
					breakdownType: "Refunded Sales",
					breakdownAmount: amount(-37.94),
					breakdowns: [
						{
							breakdownType: "ProductCharges",
							breakdownAmount: amount(-36.99),
						},
						{ breakdownType: "Tax", breakdownAmount: amount(-0.95) },
					],
				},
			],
		} as AmazonTransaction;
		const returnLabel = {
			transactionType: "Adjustment",
			breakdowns: [
				{
					breakdownType: "Expenses",
					breakdownAmount: amount(-6.65),
					breakdowns: [
						{
							breakdownType: "Other",
							breakdownAmount: amount(-6.65),
							breakdowns: [
								{
									breakdownType: "ReturnPostageBilling_Postage",
									breakdownAmount: amount(-6.65),
								},
							],
						},
					],
				},
			],
		} as AmazonTransaction;
		expect(amazonCharges([postage, refund, returnLabel])).toEqual([
			{ kind: "label", description: "PostageBilling_Postage", amount: 7.23 },
			{ kind: "fee", description: "AmazonFees", amount: -4.44 },
			{ kind: "adjustment", description: "Other", amount: -6.65 },
			// The buyer's tax came back from Amazon, not from us.
			{ kind: "refund", description: "Refund", amount: 36.99 },
			{
				kind: "label",
				description: "ReturnPostageBilling_Postage",
				amount: 6.65,
			},
		]);
	});

	// As Amazon answered for a real order: the label at purchase, then the
	// carrier's re-bill 16 days later, ten times the label.
	test("a carrier's re-bill is a postage adjustment, apart from the label", () => {
		const labelTransaction = (
			description: string,
			category: string,
			entry: string,
			value: number,
		) =>
			({
				transactionType: "Adjustment",
				description,
				breakdowns: [
					{ breakdownType: "Sales", breakdownAmount: amount(0) },
					{
						breakdownType: "Expenses",
						breakdownAmount: amount(value),
						breakdowns: [
							{
								breakdownType: category,
								breakdownAmount: amount(value),
								breakdowns: [
									{ breakdownType: entry, breakdownAmount: amount(value) },
								],
							},
						],
					},
				],
			}) as AmazonTransaction;
		expect(
			amazonCharges([
				labelTransaction(
					"LabmanLabelPurchase",
					"ShippingServiceCharges",
					"PostageBilling_Postage",
					-32.85,
				),
				labelTransaction(
					"LabmanLabelPurchase",
					"Other",
					"PostageBilling_OversizeSurcharge",
					-10,
				),
				labelTransaction(
					"LabmanLabelChargeBack",
					"ShippingServiceChargebacks",
					"PostageBilling_PostageAdjustment",
					-319.75,
				),
				// Whatever else a chargeback carries is the re-bill's too.
				labelTransaction(
					"LabmanLabelChargeBack",
					"ShippingServiceChargebacks",
					"PostageBilling_FuelSurcharge",
					-1.2,
				),
			]),
		).toEqual([
			{ kind: "label", description: "PostageBilling_Postage", amount: 32.85 },
			{
				kind: "label",
				description: "PostageBilling_OversizeSurcharge",
				amount: 10,
			},
			{
				kind: "postage_adjustment",
				description: "PostageBilling_PostageAdjustment",
				amount: 319.75,
			},
			{
				kind: "postage_adjustment",
				description: "PostageBilling_FuelSurcharge",
				amount: 1.2,
			},
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

	test("an amount that isn't a number fails the order", () => {
		expect(() =>
			tiktokCharges([
				{
					...row,
					revenue_breakdown: { refund_subtotal_before_discount_amount: "x" },
				},
			]),
		).toThrow();
	});
});

describe("Shopify", () => {
	const usd = (amount: number) => ({ shopMoney: { amount } });
	const whole = { pageInfo: { hasNextPage: false } };
	const order = (
		overrides: Partial<ShopifyFinanceOrder> = {},
	): ShopifyFinanceOrder => ({
		id: "gid://shopify/Order/7633729060927",
		transactions: [
			{
				kind: "AUTHORIZATION",
				status: "SUCCESS",
				amountSet: usd(29.26),
				fees: [],
			},
			{
				kind: "CAPTURE",
				status: "SUCCESS",
				amountSet: usd(29.26),
				fees: [{ type: "processing_fee", amount: { amount: 1.09 } }],
			},
		],
		refunds: [],
		lineItems: {
			...whole,
			nodes: [{ id: "line-1", nonFulfillableQuantity: 0 }],
		},
		events: {
			...whole,
			nodes: [
				{
					action: "shipping_label_created_success",
					message:
						"Darrick Trout purchased a $5.72 shipping label and the included shipping insurance premium.",
				},
			],
		},
		fulfillmentOrders: {
			...whole,
			nodes: [{ deliveryMethod: { methodType: "SHIPPING" } }],
		},
		...overrides,
	});
	const refundOf = (
		paid: number,
		lines: { quantity: number; subtotal: number; tax: number }[],
		shippingTax = 0,
		status = "SUCCESS",
	): Partial<ShopifyFinanceOrder> => ({
		transactions: [
			...order().transactions,
			{ kind: "REFUND", status, amountSet: usd(paid), fees: [] },
		],
		refunds: [
			{
				transactions: {
					...whole,
					nodes: [{ kind: "REFUND", status, amountSet: usd(paid) }],
				},
				refundLineItems: {
					...whole,
					nodes: lines.map((l) => ({
						quantity: l.quantity,
						subtotalSet: usd(l.subtotal),
						totalTaxSet: usd(l.tax),
						lineItem: { id: "line-1" },
					})),
				},
				refundShippingLines: {
					...whole,
					nodes: shippingTax ? [{ taxAmountSet: usd(shippingTax) }] : [],
				},
			},
		],
	});

	test("ShopifyQL's label cost wins once it has the order", () => {
		expect(shopifyCharges(order(), 5.5)).toEqual({
			charges: [
				{ kind: "fee", description: "Processing fee", amount: 1.09 },
				{ kind: "label", description: "Shopify Shipping labels", amount: 5.5 },
			],
			labelsPending: false,
		});
	});

	test("until then the order's label purchases stand in, marked as such", () => {
		const { charges, labelsPending } = shopifyCharges(order(), undefined);
		expect(charges).toContainEqual({
			kind: "label",
			description: "Shopify Shipping labels (until Shopify reports them)",
			amount: 5.72,
		});
		expect(labelsPending).toBe(true);
		// No label anywhere is nothing pending.
		expect(
			shopifyCharges(order({ events: { ...whole, nodes: [] } }), undefined)
				.labelsPending,
		).toBe(false);
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

	test("refunds are what was paid back, less the tax Shopify returns for us", () => {
		const refunded = order(
			refundOf(27.94, [{ quantity: 1, subtotal: 20, tax: 1.6 }], 0.84),
		);
		expect(refundedRevenue(refunded)).toBeCloseTo(25.5);
	});

	test("a refund not paid out yet takes nothing off", () => {
		const pending = refundOf(
			22,
			[{ quantity: 1, subtotal: 20, tax: 2 }],
			0,
			"PENDING",
		);
		expect(refundedRevenue(order(pending))).toBe(0);
	});

	test("a refund of only an amount, with no items, still counts", () => {
		expect(refundedRevenue(order(refundOf(10, [])))).toBe(10);
	});

	test("units refunded before shipping are already off the order's revenue", () => {
		// Two units refunded, one of which never shipped.
		const refunded = order({
			...refundOf(43.2, [{ quantity: 2, subtotal: 40, tax: 3.2 }]),
			lineItems: {
				...whole,
				nodes: [{ id: "line-1", nonFulfillableQuantity: 1 }],
			},
		});
		expect(refundedRevenue(refunded)).toBe(20);
	});

	test("an order with more than one ask reads is cut short, not summed", () => {
		expect(cutShort(order(refundOf(10, [])))).toEqual([]);
		const more = { pageInfo: { hasNextPage: true } };
		const [refund] = refundOf(10, []).refunds ?? [];
		expect(
			cutShort(
				order({
					refunds: [{ ...refund, refundLineItems: { ...more, nodes: [] } }],
					events: { ...more, nodes: [] },
				}),
			),
		).toEqual(["refunded lines", "label purchases"]);
		const transaction = order().transactions[1];
		expect(
			cutShort(order({ transactions: Array(50).fill(transaction) })),
		).toEqual(["transactions"]);
	});

	test("counter sales and pickups need no label, unknown methods might", () => {
		const at = (methodType: string) =>
			order({
				fulfillmentOrders: {
					...whole,
					nodes: [{ deliveryMethod: { methodType } }],
				},
			});
		expect(shippedWithoutLabel(at("RETAIL"))).toBe(true);
		expect(shippedWithoutLabel(at("PICK_UP"))).toBe(true);
		expect(shippedWithoutLabel(at("SHIPPING"))).toBe(false);
		expect(
			shippedWithoutLabel(
				order({
					fulfillmentOrders: { ...whole, nodes: [{ deliveryMethod: null }] },
				}),
			),
		).toBe(false);
		expect(
			shippedWithoutLabel(
				order({ fulfillmentOrders: { ...whole, nodes: [] } }),
			),
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
