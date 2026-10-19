// Ticking orders in the list, and what the Print button prints.
//
// Ticks are kept by order id, so a reload or a re-sort keeps them. Only the
// ticked orders still shown count: hiding one behind a filter takes it out
// of the print, and clearing the filter brings it back ticked. What looks
// ticked is always exactly what prints.

type Row = { id: number; labelToVoid: boolean; invoicePrintedAt: Date | null };

export type Ticks = ReadonlySet<number>;

// The ticked orders that are shown, in the order shown.
export function tickedRows<R extends Row>(ticks: Ticks, shown: readonly R[]) {
	return shown.filter((o) => ticks.has(o.id));
}

// Ticks or unticks the row at `index`. With `range`, every row from the
// last one clicked (`anchor`) to this one takes this row's new state, like
// shift-clicking in a mail list.
export function toggle(
	ticks: Ticks,
	shown: readonly Row[],
	index: number,
	anchor: number | null,
	range: boolean,
): Ticks {
	const row = shown[index];
	if (!row) return ticks;
	const on = !ticks.has(row.id);
	const from = range && anchor !== null ? Math.min(anchor, index) : index;
	const to = range && anchor !== null ? Math.max(anchor, index) : index;
	const next = new Set(ticks);
	for (const o of shown.slice(from, to + 1)) {
		if (on) next.add(o.id);
		else next.delete(o.id);
	}
	return next;
}

// The header box: ticks every shown order, or unticks them when all are.
// Ticks hidden by the filter are left alone.
export function toggleAll(ticks: Ticks, shown: readonly Row[]): Ticks {
	const all = shown.length > 0 && shown.every((o) => ticks.has(o.id));
	const next = new Set(ticks);
	for (const o of shown) {
		if (all) next.delete(o.id);
		else next.add(o.id);
	}
	return next;
}

export function headerState(ticks: Ticks, shown: readonly Row[]) {
	const n = tickedRows(ticks, shown).length;
	return n === 0 ? "none" : n === shown.length ? "all" : "some";
}

// What the Print button prints, or null when there's nothing to.
//   - Ticked orders, when any are: exactly those, on any tab, printed
//     before or not. Ticking is how an invoice prints again.
//   - Otherwise, on To ship with nothing filtered: every order still to
//     ship that hasn't been printed, worked out by the server (the list
//     stops at 500).
//   - Otherwise, on To ship: the orders shown that haven't been printed,
//     leaving out cancelled ones still listed only for their label to void.
//   - "done" when every order those would print already has been, so the
//     button can say so rather than vanish.
// All orders lists the past too, so it prints only what's ticked.
export type PrintPlan =
	| { kind: "all"; skipped: number }
	| {
			kind: "ids";
			ids: number[];
			why: "ticked" | "shown";
			leftOut: number;
			skipped: number;
	  }
	| { kind: "done" };

export function printPlan({
	view,
	ticks,
	shown,
	filtering,
}: {
	view: "ship" | "all";
	ticks: Ticks;
	shown: readonly Row[];
	filtering: boolean;
}): PrintPlan | null {
	const ticked = tickedRows(ticks, shown);
	if (ticked.length > 0) {
		return {
			kind: "ids",
			ids: ticked.map((o) => o.id),
			why: "ticked",
			leftOut: 0,
			skipped: 0,
		};
	}
	if (view !== "ship" || shown.length === 0) return null;
	const printable = shown.filter((o) => !o.labelToVoid);
	const fresh = printable.filter((o) => o.invoicePrintedAt === null);
	const skipped = printable.length - fresh.length;
	if (printable.length === 0) return null;
	if (fresh.length === 0) return { kind: "done" };
	if (!filtering) return { kind: "all", skipped };
	return {
		kind: "ids",
		ids: fresh.map((o) => o.id),
		why: "shown",
		leftOut: shown.length - printable.length,
		skipped,
	};
}
