import { type Priority, WAIT_DAYS } from "./priority";

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
	// What waiting a week would cost (./priority.ts); null when it can't be
	// valued.
	priority: Priority | null;
};

// Whether a supplier's suggested PO is worth sending. "ready": the total
// reached the supplier's minimum order. "short": it hasn't, but waiting
// already loses profit, so it's shown anyway and someone decides. "waiting":
// neither yet.
export type Readiness = "ready" | "short" | "waiting";

// Less than this lost a week isn't worth acting on: it doesn't put a product
// on a PO by itself or show a supplier under its minimum.
export const MIN_AT_RISK = 10;

export type SupplierSuggestion = {
	supplierId: number;
	supplierName: string;
	minimumOrder: number;
	lines: SuggestedLine[];
	// Lines without a price add nothing here.
	total: number;
	unpriced: number;
	// Profit its lines lose if the PO waits a week, summed.
	atRisk: number;
	readiness: Readiness;
	draftId: number | null;
};

// Suggestions to start a PO from: ready, and not already on a draft. Once a
// supplier has a draft, its suggestion lives there (see draftChanges).
export function readyToOrder(suggestions: SupplierSuggestion[]) {
	return suggestions.flatMap(({ draftId, readiness, ...s }) =>
		readiness === "waiting" || draftId !== null ? [] : [{ ...s, readiness }],
	);
}

export function readiness(s: {
	total: number;
	minimumOrder: number;
	atRisk: number;
}): Readiness {
	if (s.total >= s.minimumOrder) return "ready";
	if (s.atRisk >= MIN_AT_RISK) return "short";
	return "waiting";
}

// Whether a product that needs ordering goes on its supplier's PO by itself:
// a week sold out would lose at least MIN_AT_RISK of profit, its own or its
// tool sets'. That's what it earns, not how soon it runs out, so a PO's
// cover days still decide how far ahead it's bought. The rest (thin or
// sporadic earners, and unpriced ones that can't be valued) are recommended
// instead, so someone decides whether they're worth restocking.
export const ordersItself = (priority: Priority | null) =>
	priority !== null &&
	(priority.own + priority.sets) * WAIT_DAYS >= MIN_AT_RISK;
