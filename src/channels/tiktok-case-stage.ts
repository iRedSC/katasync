import type { RequestStage, ReturnStatus } from "#/orders/return-requests";

export const TIKTOK_RETURN_STATES = {
	RETURN_OR_REFUND_REQUEST_PENDING: ["requested", "us"],
	REFUND_OR_RETURN_REQUEST_REJECT: ["cancelled", "nobody"],
	AWAITING_BUYER_SHIP: ["requested", "buyer"],
	BUYER_SHIPPED_ITEM: ["shipped", "marketplace"],
	REJECT_RECEIVE_PACKAGE: ["cancelled", "nobody"],
	RETURN_OR_REFUND_REQUEST_SUCCESS: ["processing", "marketplace"],
	RETURN_OR_REFUND_REQUEST_CANCEL: ["cancelled", "nobody"],
	RETURN_OR_REFUND_REQUEST_COMPLETE: ["closed", "nobody"],
	AWAITING_BUYER_RESPONSE: ["requested", "buyer"],
	REPLACEMENT_REQUEST_PENDING: ["requested", "us"],
	REPLACEMENT_REQUEST_REJECT: ["cancelled", "nobody"],
	REPLACEMENT_REQUEST_REFUND_SUCCESS: ["processing", "marketplace"],
	REPLACEMENT_REQUEST_CANCEL: ["cancelled", "nobody"],
	REPLACEMENT_REQUEST_COMPLETE: ["closed", "nobody"],
	EXCHANGE_REQUEST_PENDING: ["requested", "us"],
	EXCHANGE_REQUEST_REFUND_SUCCESS: ["processing", "marketplace"],
	EXCHANGE_REQUEST_CANCEL: ["cancelled", "nobody"],
	EXCHANGE_REQUEST_COMPLETE: ["closed", "nobody"],
} as const satisfies Record<
	string,
	readonly [ReturnStatus, RequestStage["waitingOn"]]
>;

export const TIKTOK_AFTERSALES_STATES = [
	"INIT",
	"PENDING_REQUEST_REVIEW",
	"REQUEST_REVIEW_COMPLETED",
] as const;
export const TIKTOK_RMA_STATES = [
	"INIT",
	"AWAITING_BUYER_RETURN",
	"RETURN_IN_TRANSIT",
	"PENDING_PACKAGE_REVIEW",
	"PACKAGE_REVIEW_COMPLETED",
] as const;
export const TIKTOK_ARBITRATION_STATES = {
	IN_PROGRESS: "in_progress",
	SUPPORT_BUYER: "buyer_won",
	SUPPORT_SELLER: "seller_won",
	CLOSED: "closed",
} as const satisfies Record<string, RequestStage["escalation"]>;

export type TiktokStageInput = {
	return_status: string;
	return_type?: string;
	arbitration_status?: string;
	seller_next_action_response?: { action: string; deadline?: number }[];
	afterSalesStatus?: string;
	rmaStatus?: string;
};

function knownEntry<Value>(
	entries: Record<string, Value>,
	key: string,
): Value | undefined {
	return Object.hasOwn(entries, key) ? entries[key] : undefined;
}

// SKU outcomes establish settlement; parent review completion does not.
export function tiktokReturnStage(
	input: TiktokStageInput,
): RequestStage & { problems: string[] } {
	const problems: string[] = [];
	const known = knownEntry(TIKTOK_RETURN_STATES, input.return_status);
	let status: ReturnStatus = known?.[0] ?? "unknown";
	let owner: RequestStage["waitingOn"] = known?.[1] ?? "marketplace";
	if (!known)
		problems.push(`Unknown TikTok return status: ${input.return_status}`);
	const escalation = input.arbitration_status
		? (knownEntry(TIKTOK_ARBITRATION_STATES, input.arbitration_status) ?? null)
		: null;
	if (input.arbitration_status && escalation === null)
		problems.push(
			`Unknown TikTok arbitration status: ${input.arbitration_status}`,
		);
	for (const [value, values, name] of [
		[input.afterSalesStatus, TIKTOK_AFTERSALES_STATES, "aftersales"],
		[input.rmaStatus, TIKTOK_RMA_STATES, "RMA"],
	] as const) {
		if (value && !values.some((knownStatus) => knownStatus === value)) {
			problems.push(`Unknown TikTok ${name} status: ${value}`);
			status = "unknown";
			owner = "marketplace";
		}
	}
	const resolved = () => status === "closed" || status === "cancelled";
	if (status !== "unknown") {
		if (
			!resolved() &&
			(input.afterSalesStatus === "INIT" || input.rmaStatus === "INIT")
		) {
			status = "processing";
			owner = "marketplace";
		}
		if (input.rmaStatus === "AWAITING_BUYER_RETURN") {
			status = "requested";
			owner = "buyer";
		}
		if (input.rmaStatus === "RETURN_IN_TRANSIT") {
			status = "shipped";
			owner = "marketplace";
		}
		if (
			input.afterSalesStatus === "PENDING_REQUEST_REVIEW" &&
			!input.rmaStatus
		) {
			if (resolved()) status = "processing";
			owner = "us";
		}
		if (input.rmaStatus === "PENDING_PACKAGE_REVIEW") {
			status = "delivered";
			owner = "us";
		}
	}
	if (
		escalation === "in_progress" ||
		(input.arbitration_status && escalation === null)
	) {
		if (resolved()) status = "processing";
		owner = "marketplace";
	}
	const actions = input.seller_next_action_response ?? [];
	if (actions.length > 0) {
		if (resolved()) status = "processing";
		owner = "us";
	}
	const deadlines = actions.flatMap((action) =>
		action.deadline === undefined ? [] : [action.deadline],
	);
	const respondBy =
		owner === "us" && deadlines.length > 0
			? new Date(Math.min(...deadlines) * 1000)
			: null;
	const kind = input.return_type === "REFUND" ? "refund" : "return";
	if (kind === "refund" && (status === "shipped" || status === "delivered")) {
		problems.push(`TikTok refund has shipping status: ${input.return_status}`);
		status = "unknown";
	}
	const details = { escalation, problems };
	if (status === "closed" || status === "cancelled")
		return { kind, status, waitingOn: "nobody", respondBy: null, ...details };
	const ownership =
		owner === "us"
			? { waitingOn: "us" as const, respondBy }
			: {
					waitingOn:
						owner === "buyer" ? ("buyer" as const) : ("marketplace" as const),
					respondBy: null,
				};
	if (kind === "refund")
		return {
			kind,
			status:
				status === "shipped" || status === "delivered" ? "unknown" : status,
			...ownership,
			...details,
		};
	return { kind, status, ...ownership, ...details };
}
