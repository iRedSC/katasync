import { expect, test } from "vitest";
import {
	amazonReturnStage,
	EBAY_CASE_STATES,
	ebayReturnStage,
	SHOPIFY_CASE_STATES,
	shopifyReturnStage,
} from "./marketplace-case-stage";

test.each([
	[
		"eBay seller review",
		ebayReturnStage("RETURN_REQUESTED"),
		"requested",
		"us",
	],
	[
		"eBay approved shipment",
		ebayReturnStage("ITEM_READY_TO_SHIP"),
		"requested",
		"buyer",
	],
	[
		"Shopify seller review",
		shopifyReturnStage("REQUESTED", false),
		"requested",
		"us",
	],
	[
		"Shopify approved shipment",
		shopifyReturnStage("OPEN", false),
		"requested",
		"buyer",
	],
	[
		"Amazon unestablished pending review",
		amazonReturnStage({ status: "Pending", tracked: false, delivered: false }),
		"unknown",
		"marketplace",
	],
	[
		"Amazon approved shipment",
		amazonReturnStage({ status: "Approved", tracked: false, delivered: false }),
		"requested",
		"buyer",
	],
] as const)("%s", (_name, mapped, status, waitingOn) => {
	expect(mapped).toMatchObject({ status, waitingOn, respondBy: null });
});

test.each([
	ebayReturnStage("FUTURE_STATE"),
	shopifyReturnStage("FUTURE_STATE", true),
	amazonReturnStage({
		status: "FUTURE_STATE",
		tracked: false,
		delivered: false,
	}),
])("unsupported ownership stays visibly unknown: %o", (mapped) => {
	expect(mapped).toMatchObject({
		status: "unknown",
		waitingOn: "marketplace",
		respondBy: null,
	});
	expect(mapped).toHaveProperty("problems", [expect.any(String)]);
});

test("raw state enum additions require explicit expectations", () => {
	expect(Object.keys(SHOPIFY_CASE_STATES)).toEqual([
		"REQUESTED",
		"OPEN",
		"CLOSED",
		"CANCELED",
		"DECLINED",
	]);
	expect(Object.keys(EBAY_CASE_STATES)).toEqual([
		"AUTO_REFUND_INITIATED",
		"CLOSED",
		"INITIAL",
		"ITEM_DELIVERED",
		"ITEM_KEPT",
		"ITEM_READY_TO_SHIP",
		"ITEM_SHIPPED",
		"LESS_THAN_A_FULL_REFUND_ISSUED",
		"PARTIAL_REFUND_AS_PAYOUT_INITIATED",
		"PARTIAL_REFUND_DECLINED",
		"PARTIAL_REFUND_FAILED",
		"PARTIAL_REFUND_INITIATED",
		"PARTIAL_REFUND_NON_PAYPAL_INITIATED",
		"PARTIAL_REFUND_REQUESTED",
		"PARTIAL_REFUNDED",
		"PAYOUT_INITIATED",
		"REFUND_AS_PAYOUT_INITIATED",
		"REFUND_FAILED",
		"REFUND_INITIATED",
		"REFUND_SENT_PENDING_CONFIRMATION",
		"REFUND_TIMEOUT",
		"REPLACED",
		"REPLACEMENT_CLOSED",
		"REPLACEMENT_DELIVERED",
		"REPLACEMENT_LABEL_PENDING",
		"REPLACEMENT_LABEL_PENDING_TIMEOUT",
		"REPLACEMENT_LABEL_REQUESTED",
		"REPLACEMENT_LABEL_REQUESTED_TIMEOUT",
		"REPLACEMENT_OFFER_PENDING",
		"REPLACEMENT_REQUEST_TIMEOUT",
		"REPLACEMENT_REQUESTED",
		"REPLACEMENT_RMA_PENDING",
		"REPLACEMENT_SHIPPED",
		"REPLACEMENT_STARTED",
		"RETURN_LABEL_PENDING",
		"RETURN_LABEL_PENDING_TIMEOUT",
		"RETURN_LABEL_REQUESTED",
		"RETURN_LABEL_REQUESTED_TIMEOUT",
		"RETURN_REJECTED",
		"RETURN_REQUEST_TIMEOUT",
		"RETURN_REQUESTED",
		"RMA_PENDING",
		"UNKNOWN",
	]);
});
