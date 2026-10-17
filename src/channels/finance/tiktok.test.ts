import { describe, expect, test } from "vitest";
import {
	allocateFinanceToUnits,
	buyerPaidShippingFromOrder,
	estimatedShippingFromOrder,
	isTiktokShippingEstimated,
	parseOrderFinance,
	parseSignedAmount,
	reconcileBuyerPaidShipping,
	TIKTOK_ESTIMATED_FEE_LABEL,
	TIKTOK_ESTIMATED_FEE_RATE,
	tiktokString,
} from "./tiktok";

const statementPayload = {
	code: 0,
	data: {
		currency: "VND",
		fee_and_tax_amount: "-32205",
		order_create_time: 1774685957,
		order_id: "583272927048795256",
		revenue_amount: "99000",
		settlement_amount: "66795",
		shipping_cost_amount: "0",
		sku_transactions: [
			{
				fee_tax_amount: "-32205",
				fee_tax_breakdown: {
					fee: {
						affiliate_commission_amount: "-9900",
						affiliate_commission_amount_before_pit: "-9900",
						platform_commission_amount: "-12870",
						referral_fee_amount: "0",
						transaction_fee_amount: "-4950",
						vn_fix_infrastructure_fee: "-3000",
					},
					tax: {
						pit_amount: "-495",
						sales_tax_amount: "-1200",
						vat_amount: "-990",
					},
				},
				quantity: "1",
				shipping_cost_amount: "0",
				shipping_cost_breakdown: {
					actual_shipping_fee_amount: "-14000",
					customer_paid_shipping_fee_amount: "5000",
					shipping_fee_discount_amount: "14000",
					supplementary_component: {
						fbt_fulfillment_fee_amount: "-4000",
						platform_shipping_fee_discount_amount: "14000",
					},
				},
				sku_id: "1734491732301285269",
				sku_name: "AOTHUN",
			},
		],
		total_count: 1,
	},
	message: "Success",
};

describe("TikTok finance contracts", () => {
	test("uses the US order payment field as the buyer-paid shipping source", () => {
		expect(
			buyerPaidShippingFromOrder({
				payment: {
					original_shipping_fee: "11.11",
					shipping_fee: "0",
					shipping_fee_seller_discount: "11.11",
				},
			}),
		).toBe(0);
		expect(
			buyerPaidShippingFromOrder({ payment_info: { shipping_fee: "5.83" } }),
		).toBe(5.83);
		expect(
			estimatedShippingFromOrder({
				payment: { original_shipping_fee: "11.11" },
			}),
		).toBe(11.11);
	});

	test("reconciles SKU shipping shares to the checkout total", () => {
		const shares = [
			{
				fees: 0,
				feesBreakdown: [],
				shipping: 2,
				shippingBreakdown: [],
				buyerPaidShipping: 2,
			},
			{
				fees: 0,
				feesBreakdown: [],
				shipping: 4,
				shippingBreakdown: [],
				buyerPaidShipping: 4,
			},
		];

		expect(reconcileBuyerPaidShipping(shares, [1, 1], 3)).toEqual([1, 2]);
		expect(reconcileBuyerPaidShipping(shares, [1, 1], 0)).toEqual([0, 0]);
	});

	test("treats unsettled rows with real label costs as known, not estimated", () => {
		expect(isTiktokShippingEstimated("settled", 0)).toBe(false);
		expect(isTiktokShippingEstimated("unsettled", 6.48)).toBe(false);
		expect(isTiktokShippingEstimated("unsettled", 0)).toBe(true);
		expect(isTiktokShippingEstimated("estimated", 0)).toBe(true);
	});

	test("matches numeric and string TikTok order ids", () => {
		expect(tiktokString(123456789)).toBe("123456789");
		expect(tiktokString("576932018345678901")).toBe("576932018345678901");
	});

	test("parses estimated fees and label costs from an unsettled transaction", () => {
		const [row] = parseOrderFinance({
			est_fee_tax_amount: "-1.05",
			est_shipping_cost_amount: "0",
			fee_tax_breakdown: {
				fee: { referral_fee_amount: "-1.05" },
				tax: {
					sales_tax_amount: "-1.54",
					sales_tax_payment_amount: "1.54",
				},
			},
			shipping_cost_breakdown: {
				actual_shipping_fee_amount: "-6.48",
				customer_paid_shipping_fee_amount: "6.48",
				shipping_fee_discount_amount: "0",
				supplementary_component: {
					fbm_shipping_cost_amount: "-6.48",
				},
			},
		});

		expect(row).toMatchObject({
			skuId: "",
			fees: 1.05,
			shipping: 6.48,
			buyerPaidShipping: 6.48,
		});
		expect(row.feesBreakdown).toEqual([["referral_fee", 1.05]]);
		expect(row.shippingBreakdown).toEqual([["actual_shipping_fee", 6.48]]);
	});

	test("parses SKU statement transactions into seller fees and net shipping", () => {
		const [row] = parseOrderFinance(statementPayload);

		expect(row).toMatchObject({
			skuId: "1734491732301285269",
			quantity: 1,
			shipping: 0,
			buyerPaidShipping: 5000,
		});
		expect(row.fees).toBe(32205);
		expect(row.feesBreakdown).toEqual([
			["affiliate_commission", 9900],
			["platform_commission", 12870],
			["transaction_fee", 4950],
			["vn_fix_infrastructure_fee", 3000],
			["pit", 495],
			["vat", 990],
		]);
		expect(row.shippingBreakdown).toEqual([
			["actual_shipping_fee", 14000],
			["shipping_fee_discount", 14000],
		]);
	});

	test("splits a SKU finance row across matching units and estimates unknown SKUs", () => {
		const [skuFinance] = parseOrderFinance(statementPayload);
		const shares = allocateFinanceToUnits(
			[
				{ skuId: "1734491732301285269", quantity: 2, price: 50 },
				{ skuId: "other", quantity: 1, price: 100 },
			],
			[skuFinance],
		);

		expect(shares[0].fees).toBe(32205 / 2);
		expect(shares[0].buyerPaidShipping).toBe(2500);
		expect(shares[1].fees).toBe(100 * TIKTOK_ESTIMATED_FEE_RATE);
		expect(shares[1].feesBreakdown).toEqual([[TIKTOK_ESTIMATED_FEE_LABEL, 6]]);
	});

	test("splits order-level finance across every unit", () => {
		const shares = allocateFinanceToUnits(
			[
				{ skuId: "a", quantity: 1, price: 10 },
				{ skuId: "b", quantity: 1, price: 10 },
			],
			[
				{
					skuId: "",
					quantity: 1,
					fees: 8,
					feesBreakdown: [["platform_commission", 8]],
					shipping: 4,
					shippingBreakdown: [["actual_shipping_fee", 4]],
					buyerPaidShipping: 2,
				},
			],
		);

		expect(shares).toEqual([
			{
				fees: 4,
				feesBreakdown: [["platform_commission", 4]],
				shipping: 2,
				shippingBreakdown: [["actual_shipping_fee", 2]],
				buyerPaidShipping: 1,
			},
			{
				fees: 4,
				feesBreakdown: [["platform_commission", 4]],
				shipping: 2,
				shippingBreakdown: [["actual_shipping_fee", 2]],
				buyerPaidShipping: 1,
			},
		]);
	});

	test("parses signed decimal strings", () => {
		expect(parseSignedAmount("-12.50")).toBe(-12.5);
		expect(parseSignedAmount({ amount: "3" })).toBe(3);
	});
});
