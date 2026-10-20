import { optimistic, type Patch } from "#/lib/optimism";
import { lineCents, sameDiscounts } from "#/purchasing/discount";
import { orderedItems } from "#/purchasing/sets";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { byAdded } from "./new-lines";
import type { Line } from "./types";

// Not sent yet: lines are edited as a draft's are.
export const isUnsent = (status: PurchaseOrderDetail["order"]["status"]) =>
	status === "draft" || status === "suggested";

// The page's data with changes the server hasn't confirmed laid over it.
export const poData = optimistic<PurchaseOrderDetail>("purchase-order");

// Changes the lines a patch matches, on the PO it was made on. A draft's
// lines match by product, since a suggested PO's lines are made again as it
// loads; a sent PO's match by line.
export function patchLines(
	purchaseOrderId: number,
	match: (l: Line) => boolean,
	change: (l: Line) => Line | null,
	{ draftEdit = false } = {},
): Patch {
	return poData.patch(purchaseOrderId, (d) => {
		const lines = d.lines.flatMap((l) => {
			if (!match(l)) return [l];
			const next = change(l);
			return next === null ? [] : [next];
		});
		// A suggested PO's first change saves it as a draft.
		const status =
			draftEdit && d.order.status === "suggested" ? "draft" : d.order.status;
		return { ...d, lines, order: { ...d.order, status } };
	});
}

// Puts a line back where it sat, as it was, unless the PO already has it.
// The server gets its addedAt back too, so it keeps the place.
export const putLineBack = (purchaseOrderId: number, line: Line) =>
	poData.patch(purchaseOrderId, (d) =>
		d.lines.some((l) => l.productId === line.productId)
			? d
			: { ...d, lines: [...d.lines, line].sort(byAdded) },
	);

// Receiving more than a line expects makes it expect what came.
export const receivedPatch = (
	purchaseOrderId: number,
	line: Line,
	quantity: number,
) =>
	patchLines(
		purchaseOrderId,
		(l) => l.id === line.id,
		(l) => {
			const received = l.received + quantity;
			return { ...l, received, quantity: Math.max(l.quantity, received) };
		},
	);

// How a line differs from what the supplier was sent: amended when it was
// added after sending, adjusted when its quantity, cost, or discounts changed
// since.
// A draft has sent nothing, so nothing on it has changed.
type SinceSent = "amended" | "adjusted" | null;
export function sinceSent(l: Line, sent: boolean): SinceSent {
	if (!sent) return null;
	if (l.sentQuantity === null) return "amended";
	return l.quantity !== l.sentQuantity ||
		l.unitCost !== l.sentUnitCost ||
		!sameDiscounts(l.discounts, l.sentDiscounts)
		? "adjusted"
		: null;
}

// What a draft comes to once sent: each product's own line plus the sets'
// parts bought here, rounded up to whole units once, at the line's price or
// else the part's.
export function draftTotals(d: PurchaseOrderDetail) {
	let units = 0;
	let total = 0;
	let unpriced = 0;
	for (const [productId, items] of orderedItems(
		d.lines,
		d.setParts,
		d.supplier.id,
	)) {
		const line = d.lines.find(
			(l) => l.productId === productId && l.kind !== "bundle",
		);
		const priced = line ?? d.setParts.find((p) => p.productId === productId);
		units += items;
		if (!priced || priced.unitCost === null) unpriced++;
		// Its line's discounts on everything the draft orders of it, sets'
		// parts included, as the line will have once they're added in.
		else
			total +=
				(lineCents(
					{ quantity: items / priced.packSize, unitCost: priced.unitCost },
					line?.discounts ?? [],
				) ?? 0) / 100;
	}
	return { units, total, unpriced };
}
