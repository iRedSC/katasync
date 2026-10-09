import { describe, expect, test } from "vitest";
import {
	amazonItem,
	amazonOrder,
	amazonToChannelOrder,
	planAmazonWindows,
} from "./amazon";
import { ebayOrder, ebayToChannelOrder } from "./ebay";

describe("amazonToChannelOrder", () => {
	const order = (extra: Record<string, unknown> = {}) =>
		amazonOrder.assert({
			AmazonOrderId: "113-0000000-0000001",
			PurchaseDate: "2026-10-08T12:00:00Z",
			LastUpdateDate: "2026-10-08T13:00:00Z",
			OrderStatus: "Unshipped",
			FulfillmentChannel: "MFN",
			OrderTotal: { CurrencyCode: "USD", Amount: "45.00" },
			ShippingAddress: {
				City: "Dover",
				StateOrRegion: "DE",
				CountryCode: "US",
			},
			...extra,
		});
	const items = [
		amazonItem.assert({
			OrderItemId: "1",
			SellerSKU: "WRENCH",
			Title: "Wrench",
			QuantityOrdered: 2,
			ItemPrice: { CurrencyCode: "USD", Amount: "40.00" },
			PromotionDiscount: { CurrencyCode: "USD", Amount: "4.00" },
			ShippingPrice: { CurrencyCode: "USD", Amount: "5.00" },
		}),
		amazonItem.assert({
			OrderItemId: "2",
			Title: "Removed",
			QuantityOrdered: 0,
		}),
	];

	test("a merchant-fulfilled order is ours to ship, at its discounted price", () => {
		const o = amazonToChannelOrder(order(), items);
		expect(o).toMatchObject({
			salesChannel: "Amazon",
			fulfillmentStatus: "UNFULFILLED",
			fulfilledByChannel: false,
			shippingCharged: 5,
			total: 45,
			shipRegion: "DE",
		});
		expect(o.lines).toEqual([
			{
				externalId: "1",
				listingExternalId: "WRENCH",
				sku: "WRENCH",
				title: "Wrench",
				quantity: 2,
				unitPrice: 18,
			},
		]);
	});

	test("an FBA order is Amazon's to ship", () => {
		const o = amazonToChannelOrder(order({ FulfillmentChannel: "AFN" }), items);
		expect(o).toMatchObject({
			salesChannel: "Amazon FBA",
			fulfilledByChannel: true,
			fulfillmentStatus: "FULFILLMENT_NOT_REQUIRED",
		});
	});

	test("a cancelled order is marked cancelled", () => {
		const o = amazonToChannelOrder(order({ OrderStatus: "Canceled" }), items);
		expect(o.cancelledAt).toEqual(new Date("2026-10-08T13:00:00Z"));
	});
});

describe("ebayToChannelOrder", () => {
	const order = (extra: Record<string, unknown> = {}) =>
		ebayOrder.assert({
			orderId: "01-00000-00001",
			legacyOrderId: "12-34567-89012",
			creationDate: "2026-10-08T12:00:00Z",
			lastModifiedDate: "2026-10-08T13:00:00Z",
			orderFulfillmentStatus: "NOT_STARTED",
			orderPaymentStatus: "PAID",
			cancelStatus: { cancelState: "NONE_REQUESTED" },
			pricingSummary: {
				total: { value: "30.00" },
				deliveryCost: { value: "6.00" },
			},
			fulfillmentStartInstructions: [
				{
					shippingStep: {
						shipTo: {
							fullName: "Pat Doe",
							contactAddress: {
								city: "Erie",
								stateOrProvince: "PA",
								countryCode: "US",
							},
						},
					},
				},
			],
			lineItems: [
				{
					lineItemId: "L1",
					sku: "BLADE",
					title: "Blade",
					quantity: 3,
					lineItemCost: { value: "27.00" },
					appliedPromotions: [{ discountAmount: { value: "3.00" } }],
				},
				{
					lineItemId: "L2",
					legacyItemId: "998877",
					title: "No SKU listing",
					quantity: 1,
					lineItemCost: { value: "5.00" },
				},
			],
			...extra,
		});

	test("maps an open eBay order", () => {
		const o = ebayToChannelOrder(order());
		expect(o).toMatchObject({
			name: "12-34567-89012",
			salesChannel: "eBay",
			fulfillmentStatus: "UNFULFILLED",
			financialStatus: "PAID",
			customerName: "Pat Doe",
			shippingCharged: 6,
		});
		expect(o.lines[0]).toMatchObject({ sku: "BLADE", unitPrice: 8 });
		// A listing without a SKU is keyed by its item ID and stays a custom item.
		expect(o.lines[1]).toMatchObject({
			sku: null,
			listingExternalId: "998877",
		});
	});

	test("cancelled and refunded states come through", () => {
		const o = ebayToChannelOrder(
			order({
				cancelStatus: { cancelState: "CANCELED" },
				orderPaymentStatus: "FULLY_REFUNDED",
			}),
		);
		expect(o.cancelledAt).toEqual(new Date("2026-10-08T13:00:00Z"));
		expect(o.financialStatus).toBe("REFUNDED");
	});
});

describe("planAmazonWindows", () => {
	const day = 24 * 60 * 60 * 1000;
	const now = 100 * day;

	test("during a backfill, recent changes come first, then two history windows", () => {
		expect(planAmazonWindows(now - 60 * day, now)).toEqual([
			{ from: now - 2 * day, until: now, advancesCursor: false },
			{ from: now - 60 * day, until: now - 57 * day, advancesCursor: true },
			{ from: now - 57 * day, until: now - 54 * day, advancesCursor: true },
		]);
	});

	test("once caught up, one window from the cursor to now", () => {
		expect(planAmazonWindows(now - 10 * 60 * 1000, now)).toEqual([
			{ from: now - 10 * 60 * 1000, until: now, advancesCursor: true },
		]);
	});
});
