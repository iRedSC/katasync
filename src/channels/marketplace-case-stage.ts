import {
	type RequestStage,
	type ReturnStatus,
	returnStage,
} from "#/orders/return-requests";

type Owner = "us" | "buyer" | "marketplace";
type RawStage = readonly [ReturnStatus, Owner];

// ReturnStateEnum includes states whose ownership needs the detail endpoint.
export const EBAY_CASE_STATES = {
	AUTO_REFUND_INITIATED: ["processing", "marketplace"],
	CLOSED: ["closed", "marketplace"],
	INITIAL: ["unknown", "marketplace"],
	ITEM_DELIVERED: ["delivered", "us"],
	ITEM_KEPT: ["requested", "us"],
	ITEM_READY_TO_SHIP: ["requested", "buyer"],
	ITEM_SHIPPED: ["shipped", "marketplace"],
	LESS_THAN_A_FULL_REFUND_ISSUED: ["unknown", "marketplace"],
	PARTIAL_REFUND_AS_PAYOUT_INITIATED: ["processing", "marketplace"],
	PARTIAL_REFUND_DECLINED: ["requested", "us"],
	PARTIAL_REFUND_FAILED: ["processing", "us"],
	PARTIAL_REFUND_INITIATED: ["processing", "marketplace"],
	PARTIAL_REFUND_NON_PAYPAL_INITIATED: ["processing", "marketplace"],
	PARTIAL_REFUND_REQUESTED: ["requested", "us"],
	PARTIAL_REFUNDED: ["unknown", "marketplace"],
	PAYOUT_INITIATED: ["unknown", "marketplace"],
	REFUND_AS_PAYOUT_INITIATED: ["processing", "marketplace"],
	REFUND_FAILED: ["processing", "us"],
	REFUND_INITIATED: ["processing", "marketplace"],
	REFUND_SENT_PENDING_CONFIRMATION: ["processing", "buyer"],
	REFUND_TIMEOUT: ["processing", "us"],
	REPLACED: ["unknown", "marketplace"],
	REPLACEMENT_CLOSED: ["closed", "marketplace"],
	REPLACEMENT_DELIVERED: ["unknown", "marketplace"],
	REPLACEMENT_LABEL_PENDING: ["unknown", "marketplace"],
	REPLACEMENT_LABEL_PENDING_TIMEOUT: ["unknown", "marketplace"],
	REPLACEMENT_LABEL_REQUESTED: ["unknown", "marketplace"],
	REPLACEMENT_LABEL_REQUESTED_TIMEOUT: ["unknown", "marketplace"],
	REPLACEMENT_OFFER_PENDING: ["unknown", "marketplace"],
	REPLACEMENT_REQUEST_TIMEOUT: ["unknown", "marketplace"],
	REPLACEMENT_REQUESTED: ["unknown", "marketplace"],
	REPLACEMENT_RMA_PENDING: ["unknown", "marketplace"],
	REPLACEMENT_SHIPPED: ["unknown", "marketplace"],
	REPLACEMENT_STARTED: ["unknown", "marketplace"],
	RETURN_LABEL_PENDING: ["unknown", "marketplace"],
	RETURN_LABEL_PENDING_TIMEOUT: ["unknown", "marketplace"],
	RETURN_LABEL_REQUESTED: ["unknown", "marketplace"],
	RETURN_LABEL_REQUESTED_TIMEOUT: ["unknown", "marketplace"],
	RETURN_REJECTED: ["cancelled", "marketplace"],
	RETURN_REQUEST_TIMEOUT: ["unknown", "marketplace"],
	RETURN_REQUESTED: ["requested", "us"],
	RMA_PENDING: ["requested", "us"],
	UNKNOWN: ["unknown", "marketplace"],
} as const satisfies Record<string, RawStage>;

export const SHOPIFY_CASE_STATES = {
	REQUESTED: ["requested", "us"],
	OPEN: ["requested", "buyer"],
	CLOSED: ["closed", "marketplace"],
	CANCELED: ["cancelled", "marketplace"],
	DECLINED: ["cancelled", "marketplace"],
} as const satisfies Record<string, RawStage>;

function mapRawStage(
	channel: string,
	raw: string,
	states: Record<string, RawStage>,
) {
	const mapped = Object.hasOwn(states, raw) ? states[raw] : undefined;
	const [status, owner] = mapped ?? ["unknown", "marketplace"];
	return {
		...returnStage(status, owner),
		problems:
			status === "unknown"
				? [`Unknown ${channel} return ownership: ${raw}`]
				: [],
	};
}

export function ebayReturnStage(raw: string) {
	return mapRawStage("eBay", raw, EBAY_CASE_STATES);
}

export function shopifyReturnStage(raw: string, tracked: boolean) {
	if (raw === "OPEN" && tracked) return returnStage("shipped", "marketplace");
	return mapRawStage("Shopify", raw, SHOPIFY_CASE_STATES);
}

export function amazonReturnStage(row: {
	status: string;
	delivered: boolean;
	tracked: boolean;
}): RequestStage & { kind: "return"; problems?: string[] } {
	const raw = row.status.trim().toLowerCase();
	if (raw === "cancelled" || raw === "canceled" || raw === "rejected")
		return returnStage("cancelled", "marketplace");
	if (raw === "closed") return returnStage("closed", "marketplace");
	if (row.delivered) return returnStage("delivered", "us");
	if (row.tracked) return returnStage("shipped", "marketplace");
	if (raw === "approved") return returnStage("requested", "buyer");
	return mapRawStage("Amazon", row.status, {});
}
