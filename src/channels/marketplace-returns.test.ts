import { describe, expect, test } from "vitest";
import { ebayReturnStatus, ebayToReturn } from "./ebay-returns";
import {
	itemReason,
	type ShopifyReturn,
	shopifyToReturn,
} from "./shopify/returns";

// How Shopify's and eBay's returns read, shaped like what each sent back
// when asked.

describe("shopifyToReturn", () => {
	const item = (
		reason: string | null,
		note: string | null,
		line = "gid://shopify/LineItem/1",
	) => ({
		quantity: 1,
		returnReasonNote: null,
		customerNote: note,
		returnReasonDefinition: reason
			? { handle: reason.toLowerCase().replace(/ /g, "-"), name: reason }
			: null,
		fulfillmentLineItem: { lineItem: { id: line, sku: "WRENCH" } },
	});
	const base: ShopifyReturn = {
		id: "gid://shopify/Return/9",
		status: "OPEN",
		createdAt: new Date("2026-10-14T01:29:18Z"),
		returnLineItems: { nodes: [item("Missing parts", null)] },
		reverseFulfillmentOrders: { nodes: [] },
	};

	test("keeps the reason, the buyer's note, and the line", () => {
		expect(
			shopifyToReturn("gid://shopify/Order/5", {
				...base,
				returnLineItems: {
					nodes: [
						item("Missing parts", "No handle in the box"),
						item("Missing parts", null, "gid://shopify/LineItem/2"),
					],
				},
			}),
		).toMatchObject({
			externalId: "gid://shopify/Return/9",
			orderExternalId: "gid://shopify/Order/5",
			status: "requested",
			reason: "Missing parts",
			note: "No handle in the box",
			lines: [
				{ lineExternalId: "gid://shopify/LineItem/1", quantity: 1 },
				{ lineExternalId: "gid://shopify/LineItem/2", quantity: 1 },
			],
		});
	});

	test("Other means the buyer's choice is in the note; Unknown is none", () => {
		expect(
			itemReason({
				returnReasonNote: "No longer needed",
				returnReasonDefinition: { handle: "other-reason", name: "Other" },
			}),
		).toBe("No longer needed");
		expect(
			itemReason({
				returnReasonNote: "",
				returnReasonDefinition: { handle: "other-reason", name: "Other" },
			}),
		).toBe("Other");
		expect(
			itemReason({
				returnReasonNote: "",
				returnReasonDefinition: { handle: "unknown", name: "Unknown" },
			}),
		).toBeNull();
		expect(
			itemReason({
				returnReasonNote: "",
				returnReasonDefinition: {
					handle: "received-the-wrong-item",
					name: "Received the wrong item",
				},
			}),
		).toBe("Received the wrong item");
	});

	test("open with a return label's tracking is on its way", () => {
		const r = shopifyToReturn("o", {
			...base,
			reverseFulfillmentOrders: {
				nodes: [
					{
						reverseDeliveries: {
							nodes: [
								{
									deliverable: {
										tracking: { number: "1Z9", carrierName: "UPS" },
									},
								},
							],
						},
					},
				],
			},
		});
		expect(r).toMatchObject({
			status: "shipped",
			trackingNumber: "1Z9",
			carrier: "UPS",
		});
		expect(shopifyToReturn("o", { ...base, status: "DECLINED" }).status).toBe(
			"cancelled",
		);
	});
});

describe("ebayToReturn", () => {
	test("one item, its transaction as the line, and what the buyer wrote", () => {
		expect(
			ebayToReturn({
				returnId: "5328864144",
				orderId: "16-15304-40650",
				state: "CLOSED",
				creationInfo: {
					reason: "DEFECTIVE_ITEM",
					comments: { content: " mud leaks from the bottom " },
					item: {
						itemId: "256999607440",
						transactionId: "10083372218602",
						returnQuantity: 1,
					},
					creationDate: { value: new Date("2026-09-01T00:00:00Z") },
				},
			}),
		).toMatchObject({
			externalId: "5328864144",
			orderExternalId: "16-15304-40650",
			status: "closed",
			reason: "DEFECTIVE_ITEM",
			note: "mud leaks from the bottom",
			lines: [{ lineExternalId: "10083372218602", quantity: 1 }],
		});
	});

	test("states", () => {
		expect(ebayReturnStatus("ITEM_SHIPPED")).toBe("shipped");
		expect(ebayReturnStatus("ITEM_DELIVERED")).toBe("delivered");
		expect(ebayReturnStatus("RETURN_REQUEST_CANCELLED")).toBe("cancelled");
		expect(ebayReturnStatus("RETURN_STARTED")).toBe("requested");
	});
});
