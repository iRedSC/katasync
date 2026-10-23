import { toast } from "sonner";
import { formatCount } from "#/lib/format";
import { ids, optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { discountProblem } from "#/purchasing/discount";
import { takenByReceiveAll } from "#/purchasing/status";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import {
	addProductToPurchaseOrder,
	amendPurchaseLine,
	receiveAllLines,
	receiveLine,
	setLine,
	setLineBackOrdered,
	setSupplierUnavailable,
	undoPurchaseReceipt,
	undoPurchaseReceipts,
} from "#/server/purchasing";
import { isUnsent, patchLines, putLineBack, receivedPatch } from "./po-data";
import type { Line } from "./types";

// Takes a line off a draft at once, with Undo once the server has it.
export async function takeOff(line: Line, purchaseOrderId: number) {
	const r = await optimism.change({
		label: `Taking ${line.sku} off`,
		patch: patchLines(
			purchaseOrderId,
			(l) => l.productId === line.productId,
			() => null,
			{ draftEdit: true },
		),
		send: () =>
			setLine({
				data: { purchaseOrderId, productId: line.productId, quantity: 0 },
			}),
	});
	if (r) offerPutBack(line, purchaseOrderId);
}

// After a draft line is taken off: Undo puts it back as it was.
function offerPutBack(line: Line, purchaseOrderId: number) {
	offerUndo(`Took ${line.sku} off this PO`, {
		undo: async () => {
			const r = await optimism.change({
				label: `Putting ${line.sku} back`,
				patch: putLineBack(purchaseOrderId, line),
				send: () => putBack(line, purchaseOrderId),
			});
			return r && `${line.sku} back on this PO`;
		},
	});
}

// Sets a line taken off a draft back as it was.
const putBack = (line: Line, purchaseOrderId: number) =>
	setLine({
		data: {
			purchaseOrderId,
			productId: line.productId,
			quantity: line.quantity,
			unitCost: line.unitCost,
			discounts: line.discounts.map(({ units, off }) => ({ units, off })),
			addedAt: line.addedAt,
		},
	});

// The PO's supplier doesn't have this product: marks it unavailable from
// them, so reorder buys it elsewhere. An unsent PO loses the line: a draft
// has it taken off, and a suggested PO drops it by itself, following
// reorder. A sent one keeps it, as what was ordered. Undo puts both back.
export async function notCarried(
	line: Line,
	po: Pick<PurchaseOrderDetail["order"], "id" | "status" | "supplierId">,
	supplierName: string,
) {
	const mark = (unavailable: boolean) =>
		setSupplierUnavailable({
			data: {
				supplierId: po.supplierId,
				productIds: [line.productId],
				unavailable,
			},
		});
	const draft = po.status === "draft";
	const thisLine = (l: Line) => l.productId === line.productId;
	const r = await optimism.change({
		label: `Removing ${line.sku} from ${supplierName}`,
		patch: isUnsent(po.status)
			? patchLines(po.id, thisLine, () => null)
			: patchLines(po.id, thisLine, (l) => ({ ...l, linkSupplierId: null })),
		send: async () => {
			await mark(true);
			if (draft)
				await setLine({
					data: {
						purchaseOrderId: po.id,
						productId: line.productId,
						quantity: 0,
					},
				});
		},
	});
	if (!r) return;
	offerUndo(`${supplierName} doesn't sell ${line.sku} now`, {
		undo: async () => {
			const back = await optimism.change({
				label: `Adding ${line.sku} back to ${supplierName}`,
				patch: isUnsent(po.status)
					? putLineBack(po.id, line)
					: patchLines(po.id, thisLine, () => line),
				send: async () => {
					await mark(false);
					if (draft) await putBack(line, po.id);
				},
			});
			return back && `${supplierName} sells ${line.sku} again`;
		},
	});
}

// Receives part or all of a sent line at once, with Undo once the server has
// it. Resolves to null when it failed and said why.
export async function receiveWithUndo(
	line: Line,
	quantity: number,
	purchaseOrderId: number,
) {
	const r = await optimism.change({
		label: `Receiving ${line.sku}`,
		patch: receivedPatch(purchaseOrderId, line, quantity),
		send: () =>
			receiveLine({ data: { lineId: ids.server(line.id), quantity } }),
	});
	if (!r) return null;
	// What the receipt made the line expect, if it raised it.
	const raisedTo =
		line.received + quantity > line.quantity ? line.received + quantity : null;
	const unit = line.packSize === 1 ? "" : ` ${line.unit}`;
	offerUndo(`Received ${formatCount(quantity)}${unit} × ${line.sku}`, {
		tone: "success",
		undo: async () => {
			const undone = await optimism.change({
				label: `Taking back ${line.sku}`,
				// As the server does: a raised line expects what it did before,
				// unless its quantity has changed since.
				patch: patchLines(
					purchaseOrderId,
					(l) => l.id === line.id,
					(l) => ({
						...l,
						received: l.received - quantity,
						quantity: l.quantity === raisedTo ? line.quantity : l.quantity,
					}),
				),
				send: () => undoPurchaseReceipt({ data: { id: r.value.receiptId } }),
			});
			return (
				undone && `Took back ${formatCount(quantity)}${unit} × ${line.sku}`
			);
		},
	});
	return r;
}

// Receives the rest of every line that isn't back-ordered, as receiveAll
// does, with one Undo for all of it once the server has it.
export async function receiveAllWithUndo(
	lines: Line[],
	purchaseOrderId: number,
) {
	const taking = lines.filter(takenByReceiveAll);
	const r = await optimism.change({
		label: "Receiving everything",
		patch: patchLines(
			purchaseOrderId,
			(l) => taking.some((t) => ids.same(t.id, l.id)),
			(l) => ({ ...l, received: Math.max(l.received, l.quantity) }),
		),
		send: () => receiveAllLines({ data: { id: purchaseOrderId } }),
	});
	if (!r) return;
	// Undone as the server received them, which may differ from what this
	// page guessed if someone else was receiving too.
	const { receipts } = r.value;
	const n = receipts.length;
	offerUndo(`Received ${n} ${n === 1 ? "line" : "lines"}`, {
		tone: "success",
		undo: async () => {
			const u = await optimism.change({
				label: "Taking everything back",
				patch: patchLines(
					purchaseOrderId,
					(l) => receipts.some((s) => ids.same(s.lineId, l.id)),
					(l) => ({
						...l,
						received:
							l.received -
							(receipts.find((s) => ids.same(s.lineId, l.id))?.quantity ?? 0),
					}),
				),
				send: () =>
					undoPurchaseReceipts({
						data: { ids: receipts.map((s) => s.receiptId) },
					}),
			});
			return u && "Took them back";
		},
	});
}

// Says what a change to a sent line did, that the supplier isn't told, and
// offers to put it back. A line added after sending and set to 0 comes off,
// so its undo adds it again.
export function amended({
	line,
	result,
	summary,
	purchaseOrderId,
}: {
	line: Line;
	result: Awaited<ReturnType<typeof amendPurchaseLine>>;
	summary: string;
	purchaseOrderId: number;
}) {
	const { was } = result;
	// The engine reloads after a failure too, so a half-done undo still shows
	// what's saved.
	const undo = async () => {
		const r = await optimism.change({
			label: `Putting ${line.sku} back`,
			patch: [
				putLineBack(purchaseOrderId, line),
				patchLines(
					purchaseOrderId,
					(l) => l.productId === line.productId,
					(l) => ({ ...l, quantity: was.quantity, unitCost: was.unitCost }),
				),
			],
			send: async () => {
				const lineId = result.removed
					? (
							await addProductToPurchaseOrder({
								data: {
									purchaseOrderId,
									productId: line.productId,
									addedAt: line.addedAt,
								},
							})
						).lineId
					: ids.server(line.id);
				await amendPurchaseLine({
					data: { lineId, quantity: was.quantity, unitCost: was.unitCost },
				});
			},
		});
		return r && `${line.sku} back as it was`;
	};
	if (result.removed) offerUndo(`Took ${line.sku} off`, { undo });
	else if (result.receivedAtOldCost)
		offerUndo(`${summary}. Received units keep the old cost.`, {
			undo,
			tone: "warning",
		});
	else offerUndo(summary, { undo });
}

// Says why a change to a line's quantity or price can't keep its discounts,
// before it shows, rather than letting the server refuse it after.
export function refusedByDiscounts(
	line: Line,
	change: { quantity?: number; unitCost?: number | null },
) {
	const problem = discountProblem({ ...line, ...change }, line.discounts);
	if (problem) toast.error(problem);
	return problem !== null;
}

// Marks a sent line back-ordered or not at once, with Undo once the server
// has it. A line already marked keeps its day.
export async function backOrderWithUndo(
	line: Line,
	backOrdered: boolean,
	purchaseOrderId: number,
) {
	const change = (value: boolean) =>
		optimism.change({
			label: `Back order on ${line.sku}`,
			patch: patchLines(
				purchaseOrderId,
				(l) => ids.same(l.id, line.id),
				(l) => ({
					...l,
					backOrderedAt: value ? (l.backOrderedAt ?? new Date()) : null,
				}),
			),
			send: () =>
				setLineBackOrdered({
					data: { lineId: ids.server(line.id), backOrdered: value },
				}),
		});
	const r = await change(backOrdered);
	if (!r) return;
	offerUndo(
		backOrdered
			? `${line.sku} back-ordered`
			: `${line.sku} no longer back-ordered`,
		{
			undo: async () => {
				const u = await change(!backOrdered);
				return u && `${line.sku} back as it was`;
			},
		},
	);
}
