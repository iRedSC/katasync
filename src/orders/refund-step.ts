import type { refundDecision } from "#/db/schema";

// Where the buyer's money stands once their return is checked in, from the
// newest refund decision (return_refunds) and what the marketplace's
// charges say it has refunded since. katasync never refunds anyone itself:
// a refund decided here is made on the marketplace, and is done once its
// charges show it, or someone says so. Pure, so the Refunds view works it
// out again after an optimistic change.

export type RefundDecisionKind = (typeof refundDecision.enumValues)[number];

export type Decision = {
	id: number;
	decision: RefundDecisionKind;
	amount: number | null;
	note: string | null;
	refundedBefore: number;
	decidedAt: Date;
	settledAt: Date | null;
};

export type RefundStepInput = {
	// When the newest thing on the order was checked in or benched.
	triagedAt: Date;
	decision: Decision | null;
	// What its marketplace's charges say is refunded now.
	refundedNow: number;
};

export type RefundStep =
	// Checked in since the last decision, or never decided.
	| { kind: "decide" }
	// A refund decided, not seen in the marketplace's charges yet.
	| { kind: "send"; decision: Decision }
	// Something else to do first.
	| { kind: "flagged"; decision: Decision }
	| {
			kind: "done";
			decision: Decision;
			// seen: in the charges; already: refunded before it was decided;
			// confirmed: said by hand; refused: no refund; resolved: other.
			how: "seen" | "already" | "confirmed" | "refused" | "resolved";
	  };

export function refundStep(o: RefundStepInput): RefundStep {
	const d = o.decision;
	if (!d || d.decidedAt < o.triagedAt) return { kind: "decide" };
	switch (d.decision) {
		case "none":
			return { kind: "done", decision: d, how: "refused" };
		case "other":
			return d.settledAt
				? { kind: "done", decision: d, how: "resolved" }
				: { kind: "flagged", decision: d };
		case "full":
		case "partial": {
			if (d.settledAt) return { kind: "done", decision: d, how: "confirmed" };
			if (o.refundedNow > d.refundedBefore)
				return { kind: "done", decision: d, how: "seen" };
			const covered =
				d.decision === "full"
					? d.refundedBefore > 0
					: d.refundedBefore >= (d.amount ?? Infinity);
			return covered
				? { kind: "done", decision: d, how: "already" }
				: { kind: "send", decision: d };
		}
	}
}

// Ours to act on, for the tab's count.
export const refundOurs = (s: RefundStep) =>
	s.kind === "decide" || s.kind === "send" || s.kind === "flagged";
