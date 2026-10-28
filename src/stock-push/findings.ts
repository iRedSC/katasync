import type { ListingStockPush } from "#/db/schema";

// What a listing katasync can't set stock for means to its channel's stock
// feed (src/diagnostics/feed-health.ts). Something gone wrong is a problem
// and keeps the feed partial. A standing fact about the listing (an adapter
// marks it byDesign) is skipped by design: counted, never a problem. This is
// the one place that decides.

type Unpushable = Extract<ListingStockPush, { state: "unpushable" }>;

export type UnpushableFinding =
	| { kind: "problem"; text: string }
	| { kind: "excluded" };

export function unpushableFinding(
	sku: string,
	channelName: string,
	sp: Unpushable,
): UnpushableFinding {
	if (sp.byDesign) return { kind: "excluded" };
	return {
		kind: "problem",
		text: `${sku}: katasync can't set its ${channelName} stock: ${sp.reason}`,
	};
}
