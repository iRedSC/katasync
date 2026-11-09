// Fixed column widths for a draft's lines and the Add more items list under
// them. Widths never follow content, so a product moving from the list onto
// the PO can't reflow either table. Product takes what's left; below the
// minimum width the tables scroll sideways rather than squeeze a column.

// Columns both tables share, in the order they share them.
const SKU = "w-40";
const MINIMUM = "w-24";
const QTY = "w-32";
const STOCK = "w-24";
const SALES = "w-24";
const PRIORITY = "w-20";
const COST = "w-32";
const AMOUNT = "w-28";

// Product keeps room for its min-w-72 cell, a set part's indent included.
export const DRAFT_MIN_WIDTH = "min-w-[78rem]";

export function DraftColumns() {
	return (
		<colgroup>
			<col />
			<col className={SKU} />
			<col className={MINIMUM} />
			<col className={QTY} />
			<col className={STOCK} />
			<col className={SALES} />
			<col className={PRIORITY} />
			<col className={COST} />
			<col className={AMOUNT} />
		</colgroup>
	);
}

// Add more items keeps only what deciding needs: stock, sales, priority,
// and what Add puts on beside its button.
export const ADD_MIN_WIDTH = "min-w-[50rem]";

export function AddColumns() {
	return (
		<colgroup>
			<col />
			<col className="w-24" />
			<col className="w-24" />
			<col className="w-24" />
			<col className="w-48" />
		</colgroup>
	);
}
