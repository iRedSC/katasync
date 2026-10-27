import type { PurchaseOrderMatch } from "#/components/po-product-picker";
import type { ReceiveLine } from "#/components/receive/line-row";
import type { ReceiptDiscount } from "#/components/receive/quantity-sheet";
import { formatMoney } from "#/lib/format";
import { ids, optimism, optimistic, type Patch } from "#/lib/optimism";
import { takenByReceiveAll } from "#/purchasing/status";
import {
	type PurchaseOrderDetail,
	receiveAllLines,
	setLineBackOrdered,
	setLineReceivingNote,
	undoPurchaseReceipt,
	undoPurchaseReceipts,
} from "#/server/purchasing";

// The receive page's data and the changes it lays over it before the server
// has them, each mirroring what the server will do.

export type Receipt = Pick<
	PurchaseOrderDetail["receipts"][number],
	"id" | "lineId" | "quantity" | "quantityBefore" | "quantityAfter"
>;

// What this page shows of the PO. Its own kind of data: a line made here (an
// extra, before the reload) has only what this page shows, so the purchasing
// page's patches can't be laid over it.
export type ReceiveOrder = {
	order: Pick<PurchaseOrderDetail["order"], "id" | "status">;
	supplier: Pick<PurchaseOrderDetail["supplier"], "name">;
	lines: ReceiveLine[];
	receipts: Receipt[];
	damages: Pick<
		PurchaseOrderDetail["damages"][number],
		"lineId" | "quantity" | "kind"
	>[];
};
export const receiveData = optimistic<ReceiveOrder>("receive-order");

export const done = (l: ReceiveLine) => l.received >= l.quantity;

export const productName = (p: Pick<ReceiveLine, "name" | "variantName">) =>
	p.variantName ? `${p.name} (${p.variantName})` : p.name;

// Receives on a line the way receive does (see src/purchasing/orders.ts): more
// than expected makes the line expect what came, and `last` makes it expect
// only what came.
export function receiveOn(
	l: ReceiveLine,
	quantity: number,
	last: boolean,
): ReceiveLine {
	const received = l.received + quantity;
	return {
		...l,
		received,
		quantity: last || received > l.quantity ? received : l.quantity,
	};
}

// Takes a receipt back off its line, as undoReceipt does: a line that still
// expects what the receipt made it expect goes back to what it expected before.
export function unreceiveOn(l: ReceiveLine, r: Receipt): ReceiveLine {
	return {
		...l,
		received: l.received - r.quantity,
		quantity:
			r.quantityBefore !== null && l.quantity === r.quantityAfter
				? r.quantityBefore
				: l.quantity,
	};
}

// The receipt a change makes, as the server will record it: what the line
// expected before and after, when the receipt changed that.
export function receiptFor(
	line: ReceiveLine,
	quantity: number,
	last: boolean,
): Receipt {
	const after = receiveOn(line, quantity, last).quantity;
	const changed = after !== line.quantity;
	return {
		id: ids.provisional(),
		lineId: line.id,
		quantity,
		quantityBefore: changed ? line.quantity : null,
		quantityAfter: changed ? after : null,
	};
}

// A line for a product the PO doesn't have yet, as receiveExtra adds it: the
// supplier's terms, expecting nothing.
export function blankLine(match: PurchaseOrderMatch, id: number): ReceiveLine {
	return {
		id,
		productId: match.productId,
		sku: match.sku,
		name: match.name,
		variantName: match.variantName,
		imageUrl: match.imageUrl,
		unit: match.unit ?? "EACH",
		packSize: match.packSize ?? 1,
		supplierCount: match.supplierCount ?? 1,
		quantity: 0,
		received: 0,
		sentQuantity: null,
		receivingNote: null,
		backOrderedAt: null,
	};
}

// The PO as receiving settles it: all in closes it, and anything still short
// keeps it open, reopening it if it was closed.
export function afterReceive(
	order: ReceiveOrder["order"],
	lines: ReceiveLine[],
): ReceiveOrder["order"] {
	return { ...order, status: lines.every(done) ? "closed" : "sent" };
}

// As undoing a receipt settles it: a closed PO that's short again reopens.
// A sent PO is left as it is, as the server leaves it.
export function afterUndo(
	order: ReceiveOrder["order"],
	lines: ReceiveLine[],
): ReceiveOrder["order"] {
	return order.status === "closed" && !lines.every(done)
		? { ...order, status: "sent" }
		: order;
}

export function receivePatch(
	orderId: number,
	lineId: number,
	receipt: Receipt,
	last: boolean,
): Patch {
	return receiveData.patch(orderId, (d) => {
		const lines = d.lines.map((l) =>
			ids.same(l.id, lineId) ? receiveOn(l, receipt.quantity, last) : l,
		);
		return {
			...d,
			lines,
			receipts: [receipt, ...d.receipts],
			order: afterReceive(d.order, lines),
		};
	});
}

// Receives the rest of every line Receive all takes, as receiveAll does, and
// offers to undo them together. Resolves to how many lines it received, or
// null when it failed and said why.
export async function receiveAll(orderId: number, lines: ReceiveLine[]) {
	const made = lines
		.filter(takenByReceiveAll)
		.map((l) => receiptFor(l, l.quantity - l.received, false));
	// One per Receive all, so a resend can't receive it twice.
	const key = crypto.randomUUID();
	const r = await optimism.change({
		label: "Receiving everything",
		patch: receiveData.patch(orderId, (d) => {
			const next = d.lines.map((l) => {
				const receipt = made.find((m) => ids.same(m.lineId, l.id));
				return receipt ? receiveOn(l, receipt.quantity, false) : l;
			});
			return {
				...d,
				lines: next,
				receipts: [...made, ...d.receipts],
				order: afterReceive(d.order, next),
			};
		}),
		send: async () => {
			const result = await receiveAllLines({ data: { key, id: orderId } });
			for (const s of result.receipts) {
				const mine = made.find((m) => ids.current(m.lineId) === s.lineId);
				if (mine) ids.confirm(mine.id, s.receiptId);
			}
			return result;
		},
	});
	if (!r) return null;
	// Undone as the server received them, which may differ from what this
	// page guessed if someone else was receiving too.
	const { receipts } = r.value;
	return {
		lines: receipts.length,
		undo: () =>
			optimism.change({
				label: "Taking everything back",
				patch: receiveData.patch(orderId, (d) => {
					const next = d.lines.map((l) => {
						const s = receipts.find((x) => ids.same(x.lineId, l.id));
						return s ? { ...l, received: l.received - s.quantity } : l;
					});
					return {
						...d,
						lines: next,
						receipts: d.receipts.filter(
							(x) => !receipts.some((s) => ids.same(x.id, s.receiptId)),
						),
						order: afterUndo(d.order, next),
					};
				}),
				send: () =>
					undoPurchaseReceipts({
						data: { ids: receipts.map((s) => s.receiptId) },
					}),
			}),
	};
}

// Receives something that isn't on the PO, or more of something that is. Its
// line is added here when the page doesn't have it yet.
export function extraPatch(
	orderId: number,
	match: PurchaseOrderMatch,
	receipt: Receipt,
): Patch {
	return receiveData.patch(orderId, (d) => {
		const lines = d.lines.some((l) => l.productId === match.productId)
			? d.lines.map((l) =>
					l.productId === match.productId
						? receiveOn(l, receipt.quantity, false)
						: l,
				)
			: [
					...d.lines,
					receiveOn(blankLine(match, receipt.lineId), receipt.quantity, false),
				];
		return {
			...d,
			lines,
			receipts: [receipt, ...d.receipts],
			order: afterReceive(d.order, lines),
		};
	});
}

// Sets what a line expects, as amendLine does. `settle` is how the PO settles
// after it.
export function expectPatch(
	orderId: number,
	lineId: number,
	quantity: number,
	settle: typeof afterReceive,
): Patch {
	return receiveData.patch(orderId, (d) => {
		const lines = d.lines.map((l) =>
			ids.same(l.id, lineId) ? { ...l, quantity } : l,
		);
		return { ...d, lines, order: settle(d.order, lines) };
	});
}

// Sets a line's receiving note, as setReceivingNote does: blank is none.
export function notePatch(
	orderId: number,
	lineId: number,
	note: string | null,
) {
	return receiveData.patch(orderId, (d) => ({
		...d,
		lines: d.lines.map((l) =>
			ids.same(l.id, lineId) ? { ...l, receivingNote: note } : l,
		),
	}));
}

export function changeNote(
	orderId: number,
	line: ReceiveLine,
	note: string | null,
	label: string,
) {
	return optimism.change({
		label,
		patch: notePatch(orderId, line.id, note),
		send: async () =>
			setLineReceivingNote({ data: { lineId: ids.server(line.id), note } }),
	});
}

// Marks a line back-ordered or not, as setBackOrdered does. A line already
// marked keeps its day.
export function changeBackOrdered(
	orderId: number,
	line: ReceiveLine,
	backOrdered: boolean,
) {
	return optimism.change({
		label: `Back order on ${productName(line)}`,
		patch: receiveData.patch(orderId, (d) => ({
			...d,
			lines: d.lines.map((l) =>
				ids.same(l.id, line.id)
					? {
							...l,
							backOrderedAt: backOrdered
								? (l.backOrderedAt ?? new Date())
								: null,
						}
					: l,
			),
		})),
		send: async () =>
			setLineBackOrdered({
				data: { lineId: ids.server(line.id), backOrdered },
			}),
	});
}

// Takes a receipt back, off its line and out of the receipts. The page may
// show the receipt and its line by the id made here or by the server's, as
// the reload may or may not be in, so either matches.
export function undoReceipt(orderId: number, r: Receipt, name: string) {
	return optimism.change({
		label: `Taking back ${name}`,
		patch: receiveData.patch(orderId, (d) => {
			const lines = d.lines.map((l) =>
				ids.same(l.id, r.lineId) ? unreceiveOn(l, r) : l,
			);
			return {
				...d,
				lines,
				receipts: d.receipts.filter((x) => !ids.same(x.id, r.id)),
				order: afterUndo(d.order, lines),
			};
		}),
		send: async () => undoPurchaseReceipt({ data: { id: ids.server(r.id) } }),
	});
}

// A receipt's discount, as its toast says it: ", 1 free", ", 10% off 4".
export function said(discount: ReceiptDiscount | undefined, quantity: number) {
	if (!discount) return "";
	const units = discount.units ?? quantity;
	const { off } = discount;
	if (off.kind === "percent" && off.percent === 100) return `, ${units} free`;
	return off.kind === "percent"
		? `, ${off.percent}% off ${units}`
		: `, ${formatMoney(off.amount)} off ${units}`;
}
