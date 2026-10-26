import type { MarketplaceCase } from "#/orders/marketplace-cases";
import type { ObligationStage } from "#/orders/return-requests";

type Stage = ObligationStage<MarketplaceCase["status"]>;
type RawStage = readonly [
	MarketplaceCase["status"],
	"us" | "buyer" | "marketplace",
];
export const INQUIRY_STATES = {
	OPEN: ["open", "us"],
	PENDING: ["processing", "marketplace"],
	WAITING_SELLER_RESPONSE: ["open", "us"],
	WAITING_BUYER_RESPONSE: ["open", "buyer"],
	CLOSED: ["closed", "marketplace"],
	CS_CLOSED: ["closed", "marketplace"],
	CLOSED_WITH_ESCALATION: ["closed", "marketplace"],
	OTHER: ["unknown", "marketplace"],
} as const satisfies Record<string, RawStage>;
export const CANCELLATION_STATES = {
	APPROVAL_PENDING: ["open", "us"],
	CLOSED: ["closed", "marketplace"],
	CONFIRM_REFUND_PENDING: ["processing", "buyer"],
	INITIAL: ["unknown", "marketplace"],
	OTHER: ["unknown", "marketplace"],
	REFUND_FAILED_RETRY: ["processing", "marketplace"],
	REFUND_INITIATED: ["processing", "marketplace"],
	REFUND_PENDING: ["processing", "marketplace"],
} as const satisfies Record<string, RawStage>;
export const ESCALATION_STATES = {
	CLOSED: ["closed", "marketplace"],
	CS_CLOSED: ["closed", "marketplace"],
	ON_HOLD: ["processing", "marketplace"],
	OPEN: ["open", "marketplace"],
	OTHER: ["unknown", "marketplace"],
	REFUND_AGREED_BUT_FAILED: ["processing", "us"],
	WAITING_CS: ["processing", "marketplace"],
	WAITING_DELIVERY: ["processing", "marketplace"],
} as const satisfies Record<string, RawStage>;
export const DISPUTE_STATES = {
	OPEN: ["processing", "marketplace"],
	ACTION_NEEDED: ["open", "us"],
	CLOSED: ["closed", "marketplace"],
} as const satisfies Record<string, RawStage>;

export function ebayCaseStage(
	kind: MarketplaceCase["kind"],
	raw: string,
	supplied: {
		deadline: Date | null;
		actions: string[];
	},
): Stage & { nextAction: string | null; problems: string[] } {
	const tables: Record<
		MarketplaceCase["kind"],
		Readonly<Record<string, RawStage>>
	> = {
		inquiry: INQUIRY_STATES,
		cancellation: CANCELLATION_STATES,
		escalation: ESCALATION_STATES,
		dispute: DISPUTE_STATES,
		claim: {},
	};
	const [status, owner] = (Object.hasOwn(tables[kind], raw)
		? tables[kind][raw]
		: undefined) ?? ["unknown", "marketplace"];
	const problems =
		status === "unknown" ? [`eBay ${kind}: unknown state ${raw}`] : [];
	const escalation: Stage["escalation"] =
		kind === "escalation"
			? status === "closed"
				? "closed"
				: "in_progress"
			: null;
	if (status === "closed" || status === "cancelled")
		return {
			status,
			waitingOn: "nobody",
			respondBy: null,
			escalation,
			nextAction: null,
			problems,
		};
	const waitingOn =
		owner === "buyer"
			? owner
			: supplied.actions.length || supplied.deadline
				? "us"
				: owner;
	const common = {
		status,
		escalation,
		nextAction: supplied.actions.join(", ") || null,
		problems,
	};
	return waitingOn === "us"
		? { ...common, waitingOn, respondBy: supplied.deadline }
		: { ...common, waitingOn, respondBy: null };
}
