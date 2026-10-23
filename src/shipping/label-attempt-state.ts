import type { labelAttempts } from "#/db/schema";

// The rules for one paid label purchase (see label_attempts in schema.ts).
// The database enforces the same transitions (drizzle/0115); these are what
// the code checks first, so a wrong move fails with a reason.

export type AttemptState = (typeof labelAttempts.$inferSelect)["state"];

const allowed: Record<AttemptState, readonly AttemptState[]> = {
	pending: ["succeeded", "failed", "unknown"],
	unknown: ["succeeded", "failed", "unknown"],
	succeeded: [],
	failed: [],
};

// The states an attempt can be in to move to `to`, for guarding the write.
export const fromStates = (to: AttemptState) =>
	(Object.keys(allowed) as AttemptState[]).filter((from) =>
		allowed[from].includes(to),
	);

export function assertTransition(from: AttemptState, to: AttemptState) {
	if (!allowed[from].includes(to)) {
		throw new Error(`A ${from} label purchase can't become ${to}`);
	}
}

// Only these let the orders get a new label: anything else may have been
// charged, or is being bought right now.
export const settled = (state: AttemptState) =>
	state === "succeeded" || state === "failed";

// The provider answered and said no: nothing was bought, so buying again is
// safe. Anything else thrown while buying (a timeout, a dropped connection,
// a server error, an answer katasync can't read) may have come after the
// charge.
export class LabelRefused extends Error {}

export const outcomeOf = (err: unknown): "failed" | "unknown" =>
	err instanceof LabelRefused ? "failed" : "unknown";

// What a bought label is, however katasync learned of it: the purchase's
// own answer, or finding it again afterwards. voided: it was refunded on the
// provider since, so it's recorded voided rather than live.
export type Label = {
	externalId: string;
	trackingNumber: string | null;
	trackingUrl: string | null;
	labelUrl: string | null;
	voided: { refundStatus: string } | null;
};

// What asking the provider about an unanswered purchase found. refused:
// the provider says this very attempt failed. pending: it shows something
// that may be this attempt but can't be settled from (still processing,
// ambiguous, or a status katasync doesn't know). none: no sign of it, which
// proves nothing, so the purchase stays unknown and keeps blocking.
export type Lookup =
	| { kind: "bought"; label: Label }
	| { kind: "refused"; why: string }
	| { kind: "pending" }
	| { kind: "none" };

type Transaction = {
	object_id: string;
	status: string;
	label_url?: string | null;
	tracking_number?: string | null;
	tracking_url_provider?: string | null;
	metadata?: string | null;
	messages?: { text?: string }[];
};

const REFUNDED = new Set(["REFUNDPENDING", "REFUNDED"]);
const BOUGHT = new Set(["SUCCESS", "REFUNDREJECTED", ...REFUNDED]);

// What Shippo's transactions for an attempt's rate say about it. Only one
// tagged with this attempt's id (buyLabel sends it as metadata) is this
// purchase; any other on the rate is someone else's and settles nothing.
export function shippoLookup(attemptId: string, found: Transaction[]): Lookup {
	const mine = found.filter((t) => t.metadata === attemptId);
	if (mine.length === 0) return { kind: "none" };
	const [only] = mine;
	if (mine.length > 1) return { kind: "pending" };
	if (BOUGHT.has(only.status)) {
		return {
			kind: "bought",
			label: {
				externalId: only.object_id,
				trackingNumber: only.tracking_number ?? null,
				trackingUrl: only.tracking_url_provider || null,
				labelUrl: only.label_url ?? null,
				voided: REFUNDED.has(only.status)
					? { refundStatus: only.status }
					: null,
			},
		};
	}
	if (only.status === "ERROR") {
		const why = (only.messages ?? []).flatMap((m) => (m.text ? [m.text] : []));
		return { kind: "refused", why: why.join("; ") || "Shippo: ERROR" };
	}
	return { kind: "pending" };
}
