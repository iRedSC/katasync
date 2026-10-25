import type { TrackingEvent } from "#/db/schema";

// What katasync can say about one package's tracking right now, wherever a
// package is shown. Each case carries only what's true in it, so a failed
// refresh can't pass for "no tracking": scans known from before stay, with
// when they're from and why they couldn't be refreshed. Shared with the
// browser.

// One answer from Shippo, as kept.
export type Tracked = {
	carrier: string;
	number: string;
	status: TrackingEvent["status"];
	statusDetail: string | null;
	statusAt: Date | null;
	eta: Date | null;
	originalEta: Date | null;
	service: string | null;
	origin: string | null;
	destination: string | null;
	history: TrackingEvent[];
	checkedAt: Date;
};

export type TrackingRead =
	// Shippo just answered.
	| { state: "fresh"; t: Tracked }
	// Shippo couldn't be asked; t is its last answer.
	| { state: "stale"; t: Tracked; failedAt: Date; why: string }
	// Shippo couldn't be asked and never has answered.
	| { state: "failed"; failedAt: Date; why: string }
	// The carrier isn't one Shippo follows.
	| { state: "unsupported" }
	// No tracking number yet.
	| { state: "untracked" };

// After a failed ask: the last answer, marked stale, or nothing at all.
export function afterFailure(
	kept: Tracked | null,
	error: unknown,
	failedAt = new Date(),
): TrackingRead {
	const why = error instanceof Error ? error.message : String(error);
	return kept
		? { state: "stale", t: kept, failedAt, why }
		: { state: "failed", failedAt, why };
}

// The scans to show, fresh or not.
export const knownOf = (r: TrackingRead | null): Tracked | null =>
	r?.state === "fresh" || r?.state === "stale" ? r.t : null;

// Shippo won't say more about a package that got there or went back.
export const TERMINAL: readonly Tracked["status"][] = ["DELIVERED", "RETURNED"];

// The carrier's own tracking page, so staff can always look for themselves.
export const carrierPage = (t: { carrier: string; number: string }) =>
	t.carrier === "ups"
		? `https://www.ups.com/track?tracknum=${t.number}`
		: t.carrier === "usps"
			? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t.number}`
			: `https://www.fedex.com/fedextrack/?trknbr=${t.number}`;
