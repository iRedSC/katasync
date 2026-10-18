import type { PartState, setCoverage } from "#/purchasing/sets";
import type { PurchaseOrderDetail } from "#/server/purchasing";

export type Line = PurchaseOrderDetail["lines"][number];
export type Recommendation = PurchaseOrderDetail["recommended"][number];

export type LineFocus = { lineId: number; nonce: number };

// A quantity being dragged, typed, or saved, before the page's data has it.
export type QuantityPreview = { lineId: number; quantity: number };

export type SetPart = PurchaseOrderDetail["setParts"][number];

// A set line's parts, where each comes from, and how it shows.
export type LineSet = {
	sets: number;
	parts: { part: SetPart; state: PartState }[];
	coverage: ReturnType<typeof setCoverage>;
	open: boolean;
	amount: number | null;
};
