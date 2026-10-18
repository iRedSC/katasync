import type { AbcClass } from "#/inventory/abc";

export type SuggestedLine = {
	productId: number;
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	supplierSku: string | null;
	// What it's ordered in. quantity and unitCost are per unit; onHand,
	// onOrder, and sold count the product.
	unit: string;
	packSize: number;
	supplierCount: number;
	minimumQuantity: number;
	onHand: number;
	onOrder: number;
	// Units sold over DEMAND_DAYS, counting tool sets as their parts.
	sold: number;
	quantity: number;
	unitCost: number | null;
	// Marked critical, an A item, or leaving a tool set unsellable (see
	// isCritical).
	critical: boolean;
};

// Why a supplier's suggested PO is ready to send, if it is. "critical": at
// least criticalThreshold of its products are critical, so it goes now
// whatever the total. "minimum": the total reached the supplier's minimum
// order. "waiting": neither yet.
export type Readiness = "critical" | "minimum" | "waiting";

export type SupplierSuggestion = {
	supplierId: number;
	supplierName: string;
	minimumOrder: number;
	criticalThreshold: number;
	lines: SuggestedLine[];
	// Lines without a price add nothing here.
	total: number;
	unpriced: number;
	// How many lines are critical.
	critical: number;
	readiness: Readiness;
	draftId: number | null;
};

// Suggestions to start a PO from: ready, and not already on a draft. Once a
// supplier has a draft, its suggestion lives there (see draftChanges).
export function readyToOrder(
	suggestions: SupplierSuggestion[],
): Omit<SupplierSuggestion, "draftId">[] {
	return suggestions
		.filter((s) => s.readiness !== "waiting" && s.draftId === null)
		.map(({ draftId: _, ...s }) => s);
}

export function readiness(s: {
	total: number;
	minimumOrder: number;
	critical: number;
	criticalThreshold: number;
}): Readiness {
	if (s.critical >= s.criticalThreshold) return "critical";
	if (s.total >= s.minimumOrder) return "minimum";
	return "waiting";
}

// A product we can't run out of: marked critical by hand, one of the A items
// that make most of the sales, or a part some tool set can't be built
// without, since the set sells nothing until it arrives.
export const isCritical = (
	marked: boolean,
	abc: AbcClass | null,
	setsBlocked: number,
) => marked || abc === "A" || setsBlocked > 0;

// Whether a product that needs ordering goes on its supplier's PO by itself:
// A and B items, which earn enough to always keep, anything marked critical,
// and parts that leave a tool set unsellable, since the set's sales wait on
// them. The rest (C items, and unpriced ones that can't be classed) are
// recommended instead, so someone decides whether they're worth restocking.
export const ordersItself = (
	marked: boolean,
	abc: AbcClass | null,
	setsBlocked: number,
) => marked || abc === "A" || abc === "B" || setsBlocked > 0;
