import { describe, expect, it } from "vitest";
import { amazonTax } from "#/channels/amazon";
import { ebayTax } from "#/channels/ebay";
import { shopifyTax } from "#/channels/shopify/channel-order";
import { tiktokTax } from "#/channels/tiktok";
import { taxLines } from "./tax";

const money = (amount: number) => ({ shopMoney: { amount } });

describe("taxLines", () => {
	it("folds the same tax together and drops what rounds to nothing", () => {
		expect(
			taxLines([
				{ jurisdiction: "CA State Tax", rate: 0.0725, amount: 1.1 },
				{ jurisdiction: "CA State Tax", rate: 0.0725, amount: 2.2 },
				{ jurisdiction: "LA County Tax", rate: 0.0025, amount: 0.001 },
			]),
		).toEqual([{ jurisdiction: "CA State Tax", rate: 0.0725, amount: 3.3 }]);
	});
});

describe("shopifyTax", () => {
	const online = {
		sourceName: "web",
		app: null,
		channelInformation: { channelDefinition: { channelName: "Online Store" } },
	};

	it("is Shopify's to pay on Shop app orders", () => {
		const tax = shopifyTax({
			...online,
			channelInformation: { channelDefinition: { channelName: "Shop" } },
			tags: [],
			currentTaxLines: [
				{ title: "New York State Tax", rate: 0.04, priceSet: money(2.2) },
			],
		});
		expect(tax).toEqual({
			remittedBy: "marketplace",
			lines: [{ jurisdiction: "New York State Tax", rate: 0.04, amount: 2.2 }],
		});
	});

	const lines = [
		{ title: "CA State Tax", rate: 0.0725, priceSet: money(7.25) },
	];

	it("is ours to pay on our own sales, by Shopify's jurisdictions", () => {
		expect(shopifyTax({ ...online, tags: [], currentTaxLines: lines })).toEqual(
			{
				remittedBy: "seller",
				lines: [{ jurisdiction: "CA State Tax", rate: 0.0725, amount: 7.25 }],
			},
		);
	});

	it("is TikTok's on an order Shopify relays, named like TikTok's own", () => {
		const tax = shopifyTax({
			...online,
			tags: ["TikTokOrderID:123"],
			currentTaxLines: [
				{ title: "Product Sales tax: Knife", rate: 0.065, priceSet: money(1) },
				{ title: "Product Sales tax: Blade", rate: 0.07, priceSet: money(2) },
				{ title: "Shipping fee tax", rate: 0, priceSet: money(0.5) },
			],
		});
		expect(tax.remittedBy).toBe("marketplace");
		expect(taxLines(tax.lines)).toEqual([
			{ jurisdiction: "Sales tax on items", rate: null, amount: 3 },
			{ jurisdiction: "Sales tax on shipping", rate: null, amount: 0.5 },
		]);
	});
});

describe("amazonTax", () => {
	it("takes the tax on discounts off", () => {
		const tax = amazonTax([
			{
				OrderItemId: "1",
				Title: "Ratchet",
				QuantityOrdered: 1,
				ItemTax: { Amount: 8 },
				PromotionDiscountTax: { Amount: 1 },
				ShippingTax: { Amount: 0.5 },
				ShippingDiscountTax: { Amount: 0.5 },
			},
		]);
		expect(tax.remittedBy).toBe("marketplace");
		expect(taxLines(tax.lines)).toEqual([
			{ jurisdiction: "Sales tax on items", rate: null, amount: 7 },
		]);
	});
});

describe("ebayTax", () => {
	it("names each tax eBay collected by its kind", () => {
		const tax = ebayTax({
			lineItems: [
				{
					lineItemId: "1",
					title: "Ratchet",
					quantity: 1,
					lineItemCost: { value: 50 },
					ebayCollectAndRemitTaxes: [
						{ taxType: "STATE_SALES_TAX", amount: { value: 4 } },
					],
				},
			],
		});
		expect(tax).toEqual({
			remittedBy: "marketplace",
			lines: [{ jurisdiction: "State sales tax", rate: null, amount: 4 }],
		});
	});
});

describe("tiktokTax", () => {
	it("keeps what the named parts miss, so lines add up to TikTok's total", () => {
		const tax = tiktokTax({
			tax: "10.00",
			product_tax: "8.00",
			shipping_fee_tax: "1.50",
		});
		expect(taxLines(tax.lines)).toEqual([
			{ jurisdiction: "Sales tax on items", rate: null, amount: 8 },
			{ jurisdiction: "Sales tax on shipping", rate: null, amount: 1.5 },
			{ jurisdiction: "Other sales tax", rate: null, amount: 0.5 },
		]);
	});
});
