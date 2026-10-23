// Spreading a PO's charges (freight, duty, fees, credits) over its lines, so
// each item's cost is what it took to get it here. On its own so the browser
// shows the same split the server posts.

export type ChargeKind = "freight" | "duty" | "fee" | "credit";

// How charges are spread: by weight when every line has one, so heavy cheap
// things carry their freight, else by what each line cost, else evenly.
export type SplitMethod = "weight" | "value" | "units";

export type SplitLine = {
	lineId: number;
	// Single items the line brings: what came on a closed PO, else what's
	// expected (or what came, if more did).
	items: number;
	gramsEach: number | null;
	// The line's value after discounts, for those items. Null with no price.
	cents: number | null;
};

export type Split = {
	method: SplitMethod;
	// Dollars added to each item, per line.
	perItem: Map<number, number>;
	// Lines that kept weight from being used, for saying so.
	unweighed: number[];
};

export function splitCharges(total: number, lines: SplitLine[]): Split {
	const bringing = lines.filter((l) => l.items > 0);
	const unweighed = bringing
		.filter((l) => !(l.gramsEach && l.gramsEach > 0))
		.map((l) => l.lineId);
	const totalCents = bringing.reduce((n, l) => n + (l.cents ?? 0), 0);
	const method: SplitMethod =
		bringing.length > 0 && unweighed.length === 0
			? "weight"
			: bringing.every((l) => l.cents !== null) && totalCents > 0
				? "value"
				: "units";
	const basis = (l: SplitLine) =>
		method === "weight"
			? l.items * (l.gramsEach ?? 0)
			: method === "value"
				? (l.cents ?? 0)
				: l.items;
	const sum = bringing.reduce((n, l) => n + basis(l), 0);
	const perItem = new Map<number, number>();
	for (const l of lines)
		perItem.set(
			l.lineId,
			l.items > 0 && sum > 0 && total !== 0
				? (total * basis(l)) / sum / l.items
				: 0,
		);
	return { method, perItem, unweighed };
}

// Basis items for a line: on a closed PO only what came is coming.
export const splitItems = (
	line: { quantity: number; packSize: number },
	received: number,
	closed: boolean,
) => (closed ? received : Math.max(line.quantity, received)) * line.packSize;
