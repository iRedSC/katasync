// Tool sets on a draft PO. A set can sit on several suppliers' drafts; each
// orders only the set's parts bought from its own supplier. Pure, so the
// server and the PO page agree on what a set orders and what it's missing.

// One part of a set line, as setPartsOf reads it.
export type SetPartInput = {
	lineId: number;
	productId: number;
	// Single items of the part in one set.
	perSet: number;
	// Who the part is bought from, or null when it has no supplier yet.
	supplierId: number | null;
	skipped: boolean;
	// The unit it lands in when sent: its line on this PO, else its supplier's.
	packSize: number;
	// The set on the part's supplier's other open POs (draft or sent) that
	// don't skip the part: how many sets each one gets this part for.
	elsewhere: {
		purchaseOrderId: number;
		status: "draft" | "sent";
		sets: number;
	}[];
};

// Where a part of a set comes from, for this PO's sets:
// here: bought from this PO's supplier, so it's on this PO.
// covered: bought elsewhere, and the supplier's POs have it for every set.
// short: nobody orders it for all the sets yet; covered says how many are.
// skipped: left out by hand.
export type PartState =
	| { kind: "here" }
	| { kind: "covered"; covered: number }
	| { kind: "short"; covered: number; noSupplier: boolean }
	| { kind: "skipped" };

export function partState(
	part: SetPartInput,
	sets: number,
	supplierId: number,
): PartState {
	if (part.skipped) return { kind: "skipped" };
	if (part.supplierId === supplierId) return { kind: "here" };
	const covered = part.elsewhere.reduce((n, p) => n + p.sets, 0);
	if (part.supplierId === null)
		return { kind: "short", covered: 0, noSupplier: true };
	return covered >= sets
		? { kind: "covered", covered }
		: { kind: "short", covered, noSupplier: false };
}

export type SetCoverage = Record<PartState["kind"], number>;

// How many of a set's parts are in each state, for its gauge.
export function setCoverage(states: PartState[]): SetCoverage {
	const counts: SetCoverage = { here: 0, covered: 0, short: 0, skipped: 0 };
	for (const s of states) counts[s.kind]++;
	return counts;
}

// The sets each other supplier still needs on its draft so every part bought
// from it is ordered for all of this PO's sets. Parts with no supplier can't
// be added anywhere, so they're left out.
export function shortBySupplier(
	parts: SetPartInput[],
	sets: number,
	supplierId: number,
): Map<number, number> {
	const short = new Map<number, number>();
	for (const p of parts) {
		const s = partState(p, sets, supplierId);
		if (s.kind !== "short" || p.supplierId === null) continue;
		const need = sets - s.covered;
		short.set(p.supplierId, Math.max(short.get(p.supplierId) ?? 0, need));
	}
	return short;
}

type LineInput = {
	id: number;
	productId: number;
	kind: string;
	quantity: number;
	packSize: number;
};

// A set line's quantity in sets: 2 boxes of 3 sets are 6.
export const setsOf = (line: { quantity: number; packSize: number }) =>
	line.quantity * line.packSize;

// Single items of each product the draft orders once it's sent, counting
// both its own line and the sets' parts bought here. Sending adds a set's
// parts onto the product's line in that line's unit, or as a new line in the
// part's unit, rounding up once on the total, so this does the same.
// quantities overrides a line's quantity, e.g. while it's being dragged.
export function orderedItems(
	lines: LineInput[],
	parts: SetPartInput[],
	supplierId: number,
	quantities: ReadonlyMap<number, number> = new Map(),
): Map<number, number> {
	const quantityOf = (l: LineInput) => quantities.get(l.id) ?? l.quantity;
	const setLines = new Map(
		lines.filter((l) => l.kind === "bundle").map((l) => [l.id, l]),
	);
	const fromSets = new Map<number, { items: number; packSize: number }>();
	for (const p of parts) {
		const line = setLines.get(p.lineId);
		if (!line) continue;
		const sets = setsOf({ ...line, quantity: quantityOf(line) });
		if (partState(p, sets, supplierId).kind !== "here") continue;
		const prev = fromSets.get(p.productId);
		fromSets.set(p.productId, {
			items: (prev?.items ?? 0) + sets * p.perSet,
			packSize: p.packSize,
		});
	}
	const items = new Map<number, number>();
	for (const l of lines) {
		if (l.kind === "bundle") continue;
		const extra = fromSets.get(l.productId)?.items ?? 0;
		items.set(
			l.productId,
			Math.ceil((quantityOf(l) * l.packSize + extra) / l.packSize) * l.packSize,
		);
	}
	for (const [productId, p] of fromSets)
		if (!items.has(productId))
			items.set(productId, Math.ceil(p.items / p.packSize) * p.packSize);
	return items;
}

// A product's place in tool sets: how many it's a part of, and how many of
// those its shelf can't build one of.
export type SetMembership = { in: number; blocked: number };

// For each product in a tool set, from the sets' recipes and what's on the
// shelf: its membership, and the floor that keeps every set buildable (the
// most of it any one set takes). Oversold counts as none.
export function setMembership(
	recipes: { productId: number; perSet: number }[],
	onHand: ReadonlyMap<number, number>,
): Map<number, SetMembership & { floor: number }> {
	const result = new Map<number, SetMembership & { floor: number }>();
	for (const r of recipes) {
		const prev = result.get(r.productId) ?? { in: 0, blocked: 0, floor: 0 };
		const shelf = Math.max(onHand.get(r.productId) ?? 0, 0);
		result.set(r.productId, {
			in: prev.in + 1,
			blocked: prev.blocked + (shelf < r.perSet ? 1 : 0),
			floor: Math.max(prev.floor, r.perSet),
		});
	}
	return result;
}
