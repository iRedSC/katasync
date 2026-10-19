import { describe, expect, test } from "vitest";
import { ebayReturnStatus, ebayToReturn } from "./ebay-returns";
import {
	itemReason,
	type ShopifyReturn,
	shopifyToReturn,
} from "./shopify/returns";
import { tiktokReturnStatus, tiktokToReturn } from "./tiktok-returns";

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

describe("tiktokToReturn", () => {
	test("units of one SKU add up, found by its TikTok order id", () => {
		expect(
			tiktokToReturn(
				{
					return_id: "4035",
					order_id: "577610389712769305",
					return_status: "AWAITING_BUYER_SHIP",
					return_type: "RETURN_AND_REFUND",
					create_time: 1792000000,
					return_reason:
						"ecom_order_delivered_refund_and_return_reason_damaged",
					return_reason_text: "Damaged item",
					return_line_items: [
						{ sku_id: "1729", seller_sku: "WRENCH" },
						{ sku_id: "1729", seller_sku: "WRENCH" },
						{ sku_id: "1730", seller_sku: "HAWK" },
					],
				},
				"Handle snapped",
			),
		).toMatchObject({
			externalId: "4035",
			orderExternalId: "577610389712769305",
			marketplaceOrderId: "tiktok:577610389712769305",
			status: "requested",
			reason: "Damaged item",
			note: "Handle snapped",
			requestedAt: new Date(1792000000 * 1000),
			lines: [
				{ lineExternalId: "1729", sku: "WRENCH", quantity: 2 },
				{ lineExternalId: "1730", sku: "HAWK", quantity: 1 },
			],
		});
	});

	test("statuses, and a refund with nothing coming back isn't due", () => {
		const s = (return_status: string, return_type?: string) =>
			tiktokReturnStatus({ return_status, return_type });
		expect(s("BUYER_SHIPPED_ITEM")).toBe("shipped");
		expect(s("RETURN_OR_REFUND_REQUEST_COMPLETE")).toBe("closed");
		expect(s("RETURN_OR_REFUND_REQUEST_CANCEL")).toBe("cancelled");
		expect(s("REFUND_OR_RETURN_REQUEST_REJECT")).toBe("cancelled");
		expect(s("RETURN_OR_REFUND_REQUEST_PENDING", "REFUND")).toBe("closed");
		expect(s("RETURN_OR_REFUND_REQUEST_PENDING")).toBe("requested");
	});
});
