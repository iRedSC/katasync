import { describe, expect, it, test } from "vitest";
import {
	collectEbayTransactionPages,
	parseEbayAmount,
	toEbayTransactions,
} from "./ebay";

const shippingLabelTransaction = {
	amount: { currency: "USD", value: "5.48" },
	bookingEntry: "DEBIT",
	buyer: { username: "babys20192020" },
	orderId: "15-15048-44325",
	paymentsEntity: "eBay Commerce Inc.",
	salesRecordReference: "0",
	transactionDate: "2026-08-20T15:18:57.383Z",
	transactionId: "09-15059-28949",
	transactionMemo: "Shipping label purchased",
	transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
	transactionType: "SHIPPING_LABEL",
};

describe("eBay finance contracts", () => {
	it("parses Finances Amount objects that include currency", () => {
		expect(parseEbayAmount({ currency: "USD", value: "5.48" })).toBe(5.48);
	});

	it("keeps known Finances fields and drops extras", () => {
		expect(toEbayTransactions([shippingLabelTransaction])).toEqual([
			{
				amount: { currency: "USD", value: "5.48" },
				orderId: "15-15048-44325",
				transactionDate: "2026-08-20T15:18:57.383Z",
				transactionId: "09-15059-28949",
				transactionMemo: "Shipping label purchased",
				transactionType: "SHIPPING_LABEL",
			},
		]);
	});

	it("strips extra fields from nested fee and line-item objects", () => {
		expect(
			toEbayTransactions([
				{
					orderId: "26-15006-87891",
					transactionType: "SALE",
					amount: { currency: "USD", value: "20.00", extra: true },
					feeJurisdiction: { region: "US", feeJurisdictionId: "CA" },
					fees: [
						{
							feeType: "FINAL_VALUE_FEE",
							amount: { currency: "USD", value: "2.00" },
							feeMemo: "ignored",
						},
					],
					orderLineItems: [
						{
							lineItemId: "123",
							sku: "ROCKSPLICER",
							marketplaceFees: [
								{
									feeType: "INSERTION_FEE",
									amount: { value: "0.35" },
									somethingNew: 1,
								},
							],
						},
					],
				},
			]),
		).toEqual([
			{
				orderId: "26-15006-87891",
				transactionType: "SALE",
				amount: { currency: "USD", value: "20.00" },
				feeJurisdiction: {},
				fees: [
					{
						feeType: "FINAL_VALUE_FEE",
						amount: { currency: "USD", value: "2.00" },
					},
				],
				orderLineItems: [
					{
						lineItemId: "123",
						marketplaceFees: [
							{
								feeType: "INSERTION_FEE",
								amount: { value: "0.35" },
							},
						],
					},
				],
			},
		]);
	});
});

describe("collectEbayTransactionPages", () => {
	test("reads pages until a short one", async () => {
		const offsets: number[] = [];
		const pages = [
			[{ transactionId: "a" }, { transactionId: "b" }],
			[{ transactionId: "c" }],
		];
		const all = await collectEbayTransactionPages({
			limit: 2,
			fetchPage: async ({ offset }) => {
				offsets.push(offset);
				return { transactions: pages[offset / 2] ?? [] };
			},
		});
		expect(all.map((t) => t.transactionId)).toEqual(["a", "b", "c"]);
		expect(offsets).toEqual([0, 2]);
	});

	test("refuses a page size that would never finish", async () => {
		await expect(
			collectEbayTransactionPages({ limit: 0, fetchPage: async () => ({}) }),
		).rejects.toThrow("above 0");
	});
});
