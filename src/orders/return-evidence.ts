import type { RequestStage } from "./return-requests";

// What a marketplace's returns report says about a return beyond where it
// stands, kept as it says it. Only Amazon's report has these so far.

export type Money = { amount: string; currency: string };

// A SAFE-T claim we filed with Amazon over a refund it gave on the return.
// There's no claim without its id.
export type SafetClaim = {
	id: string;
	// Amazon's wording.
	state: string | null;
	reason: string | null;
	reimbursement: Money | null;
	// ISO time, as jsonb keeps it.
	createdAt: string | null;
};

// The return label, as Amazon describes it.
export type ReturnLabel = {
	type: string | null;
	cost: Money | null;
	// Who pays for it: Customer, Seller, Amazon, in Amazon's words.
	paidBy: string | null;
};

// The evidence saved per request. Null means the marketplace didn't say.
export type ReturnEvidence = {
	aToZClaim: boolean | null;
	safetClaim: SafetClaim | null;
	resolution: string | null;
	inPolicy: boolean | null;
	returnType: string | null;
	label: ReturnLabel | null;
	deliveredAt: Date | null;
};

export const NO_EVIDENCE: ReturnEvidence = {
	aToZClaim: null,
	safetClaim: null,
	resolution: null,
	inPolicy: null,
	returnType: null,
	label: null,
	deliveredAt: null,
};

// What one read says of it. A field the read couldn't see (an older report
// without its columns) is left out, so the one saved stays; null is the
// marketplace saying nothing.
export type EvidenceRead = Partial<ReturnEvidence>;

// The saved evidence with what a read saw over it.
export function withRead(
	saved: ReturnEvidence,
	read: EvidenceRead,
): ReturnEvidence {
	const field = <K extends keyof ReturnEvidence>(key: K): ReturnEvidence[K] =>
		read[key] === undefined ? saved[key] : (read[key] as ReturnEvidence[K]);
	return {
		aToZClaim: field("aToZClaim"),
		safetClaim: field("safetClaim"),
		resolution: field("resolution"),
		inPolicy: field("inPolicy"),
		returnType: field("returnType"),
		label: field("label"),
		deliveredAt: field("deliveredAt"),
	};
}

// An A-to-z claim means Amazon has stepped in: escalated until the return
// is closed. Who must act still follows the return itself.
export function underAToZ<S extends RequestStage>(stage: S): S {
	return {
		...stage,
		escalation:
			stage.status === "closed" || stage.status === "cancelled"
				? "closed"
				: "in_progress",
	};
}

// What the Returns pages show of it.
export type EvidenceChips = Pick<
	ReturnEvidence,
	"aToZClaim" | "safetClaim" | "inPolicy" | "deliveredAt"
>;
