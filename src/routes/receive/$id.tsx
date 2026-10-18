import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, PackagePlus } from "lucide-react";
import { useState } from "react";
import type { PurchaseOrderMatch } from "#/components/po-product-picker";
import { DamageSheet } from "#/components/receive/damage-sheet";
import { ExtraSheet } from "#/components/receive/extra-sheet";
import { LineRow, type ReceiveLine } from "#/components/receive/line-row";
import { NoteSheet } from "#/components/receive/note-sheet";
import { receiveHead } from "#/components/receive/pwa";
import {
	QuantitySheet,
	type ReceiptDiscount,
} from "#/components/receive/quantity-sheet";
import { Saving } from "#/components/saving";
import { ReceiveSkeleton } from "#/components/skeleton";
import { formatMoney } from "#/lib/format";
import { ids, optimism, optimistic, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	amendPurchaseLine,
	closePurchaseOrder,
	getPurchaseOrder,
	type PurchaseOrderDetail,
	receiveExtraLine,
	receiveLine,
	setLineReceivingNote,
	undoPurchaseReceipt,
} from "#/server/purchasing";

export const Route = createFileRoute("/receive/$id")({
	head: receiveHead,
	loader: ({ params }) => getPurchaseOrder({ data: { id: Number(params.id) } }),
	component: ReceivePurchaseOrder,
	pendingComponent: () => <ReceiveSkeleton />,
});

type Receipt = Pick<
	PurchaseOrderDetail["receipts"][number],
	"id" | "lineId" | "quantity" | "quantityBefore" | "quantityAfter"
>;

// What this page shows of the PO. Its own kind of data: a line made here (an
// extra, before the reload) has only what this page shows, so the purchasing
// page's patches can't be laid over it.
type ReceiveOrder = {
	order: Pick<PurchaseOrderDetail["order"], "id" | "status">;
	supplier: Pick<PurchaseOrderDetail["supplier"], "name">;
	lines: ReceiveLine[];
	receipts: Receipt[];
	damages: Pick<
		PurchaseOrderDetail["damages"][number],
		"lineId" | "quantity"
	>[];
};
const receiveData = optimistic<ReceiveOrder>("receive-order");

const done = (l: ReceiveLine) => l.received >= l.quantity;

const productName = (p: Pick<ReceiveLine, "name" | "variantName">) =>
	p.variantName ? `${p.name} (${p.variantName})` : p.name;

// Receives on a line the way receive does (see src/purchasing/orders.ts): more
// than expected makes the line expect what came, and `last` makes it expect
// only what came.
function receiveOn(
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
function unreceiveOn(l: ReceiveLine, r: Receipt): ReceiveLine {
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
function receiptFor(
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
function blankLine(match: PurchaseOrderMatch, id: number): ReceiveLine {
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
	};
}

// The PO as receiving settles it: all in closes it, and anything still short
// keeps it open, reopening it if it was closed.
function afterReceive(
	order: ReceiveOrder["order"],
	lines: ReceiveLine[],
): ReceiveOrder["order"] {
	return { ...order, status: lines.every(done) ? "closed" : "sent" };
}

// As undoing a receipt settles it: a closed PO that's short again reopens.
// A sent PO is left as it is, as the server leaves it.
function afterUndo(
	order: ReceiveOrder["order"],
	lines: ReceiveLine[],
): ReceiveOrder["order"] {
	return order.status === "closed" && !lines.every(done)
		? { ...order, status: "sent" }
		: order;
}

function receivePatch(
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

// Receives something that isn't on the PO, or more of something that is. Its
// line is added here when the page doesn't have it yet.
function extraPatch(
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
function expectPatch(
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
function notePatch(orderId: number, lineId: number, note: string | null) {
	return receiveData.patch(orderId, (d) => ({
		...d,
		lines: d.lines.map((l) =>
			ids.same(l.id, lineId) ? { ...l, receivingNote: note } : l,
		),
	}));
}

function changeNote(
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

// Takes a receipt back, off its line and out of the receipts. The page may
// show the receipt and its line by the id made here or by the server's, as
// the reload may or may not be in, so either matches.
function undoReceipt(orderId: number, r: Receipt, name: string) {
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
function said(discount: ReceiptDiscount | undefined, quantity: number) {
	if (!discount) return "";
	const units = discount.units ?? quantity;
	const { off } = discount;
	if (off.kind === "percent" && off.percent === 100) return `, ${units} free`;
	return off.kind === "percent"
		? `, ${off.percent}% off ${units}`
		: `, ${formatMoney(off.amount)} off ${units}`;
}

function ReceivePurchaseOrder() {
	const loaded = Route.useLoaderData();
	const d = receiveData.useData(loaded.order.id, loaded);
	const navigate = useNavigate();
	const { order, supplier, lines, receipts } = d;
	const [sheetLineId, setSheetLineId] = useState<number | null>(null);
	const [noteLineId, setNoteLineId] = useState<number | null>(null);
	const [damageLineId, setDamageLineId] = useState<number | null>(null);
	// Single items of a line recorded as damaged, and what could still be.
	const damagedOn = (l: ReceiveLine) =>
		d.damages
			.filter((x) => ids.same(x.lineId, l.id))
			.reduce((n, x) => n + x.quantity, 0);
	const damageable = (l: ReceiveLine) =>
		Math.max(0, l.received * l.packSize - damagedOn(l));
	// Something that isn't on the PO: finding it, then counting it.
	const [extra, setExtra] = useState<
		{ step: "find" } | { step: "count"; match: PurchaseOrderMatch } | null
	>(null);

	const open = order.status === "sent";
	// A closed PO can still take back a mis-tapped receipt, and take
	// something else that was in the box.
	const undoable = open || order.status === "closed";
	const allDone = lines.length > 0 && lines.every(done);
	// Unfinished lines first; the rest sink to the bottom.
	const sorted = [...lines.filter((l) => !done(l)), ...lines.filter(done)];
	const sheetLine =
		sheetLineId === null
			? undefined
			: lines.find((l) => ids.same(l.id, sheetLineId));
	const damageLine =
		damageLineId === null
			? undefined
			: lines.find((l) => ids.same(l.id, damageLineId));
	const noteLine =
		noteLineId === null
			? undefined
			: lines.find((l) => ids.same(l.id, noteLineId));

	// Received on the spot: the line shows it at once, and the server gets it
	// in order. Undo is offered once the server has it.
	async function receive(
		line: ReceiveLine,
		quantity: number,
		last = false,
		discount?: ReceiptDiscount,
	) {
		navigator.vibrate?.(10);
		setSheetLineId(null);
		const name = productName(line);
		const receipt = receiptFor(line, quantity, last);
		const r = await optimism.change({
			label: `Receiving ${name}`,
			patch: receivePatch(order.id, line.id, receipt, last),
			send: async () => {
				const result = await receiveLine({
					data: { lineId: ids.server(line.id), quantity, last, discount },
				});
				ids.confirm(receipt.id, result.receiptId);
				return result;
			},
		});
		if (!r) return;
		const unit = line.packSize === 1 ? "" : ` ${line.unit}`;
		const total = line.received + quantity;
		const note =
			total > line.quantity
				? " The PO keeps the extra."
				: last && total < line.quantity
					? " Not waiting for the rest."
					: "";
		offerUndo(
			`Received ${quantity}${unit} × ${name}${said(discount, quantity)}.${note}`,
			{
				tone: "success",
				undo: async () => {
					const u = await undoReceipt(order.id, receipt, name);
					return u && `Undid ${name}`;
				},
			},
		);
	}

	// Stops waiting for what's left of a line, receiving none of it.
	async function noneCame(line: ReceiveLine) {
		setSheetLineId(null);
		const name = productName(line);
		const was = line.quantity;
		const r = await optimism.change({
			label: `Not waiting for ${name}`,
			patch: expectPatch(order.id, line.id, line.received, afterReceive),
			send: async () =>
				amendPurchaseLine({
					data: {
						lineId: ids.server(line.id),
						quantity: line.received,
					},
				}),
		});
		if (!r) return;
		offerUndo(`Not waiting for ${name}`, {
			undo: async () => {
				const u = await optimism.change({
					label: `Waiting for ${name} again`,
					patch: expectPatch(order.id, ids.current(line.id), was, afterUndo),
					send: async () =>
						amendPurchaseLine({
							data: { lineId: ids.server(line.id), quantity: was },
						}),
				});
				return u && `Waiting for ${name} again`;
			},
		});
	}

	async function saveNote(line: ReceiveLine, note: string | null) {
		setNoteLineId(null);
		const name = productName(line);
		const was = line.receivingNote;
		const r = await changeNote(order.id, line, note, `Note on ${name}`);
		if (!r) return;
		offerUndo(note === null ? `Removed the note on ${name}` : `Noted ${name}`, {
			undo: async () => {
				const u = await changeNote(order.id, line, was, `Note on ${name}`);
				return u && `Put the note on ${name} back`;
			},
		});
	}

	function pickExtra(match: PurchaseOrderMatch) {
		// Already on an open PO: count it on its own line. A closed PO takes
		// it as extra, which reopens and settles it in one go.
		const onPage = lines.find((l) => l.productId === match.productId);
		if (onPage && open) {
			setExtra(null);
			setSheetLineId(onPage.id);
			return;
		}
		setExtra({ step: "count", match });
	}

	// Something in the box that isn't on the PO, or more of something that is.
	// On a closed PO it reopens, as receiveExtra does.
	async function receiveExtra(
		match: PurchaseOrderMatch,
		quantity: number,
		discount?: ReceiptDiscount,
	) {
		navigator.vibrate?.(10);
		setExtra(null);
		const name = productName(match);
		const line =
			lines.find((l) => l.productId === match.productId) ??
			blankLine(match, ids.provisional());
		const receipt = receiptFor(line, quantity, false);
		const r = await optimism.change({
			label: `Receiving ${name}`,
			patch: extraPatch(order.id, match, receipt),
			send: async () => {
				const result = await receiveExtraLine({
					data: {
						purchaseOrderId: order.id,
						productId: match.productId,
						quantity,
						discount,
					},
				});
				ids.confirm(line.id, result.lineId);
				ids.confirm(receipt.id, result.receiptId);
				return result;
			},
		});
		if (!r) return;
		offerUndo(
			`Added and received ${quantity} × ${name}${said(discount, quantity)}`,
			{
				tone: "success",
				undo: async () => {
					const u = await undoReceipt(order.id, receipt, name);
					return u && `Undid ${name}`;
				},
			},
		);
	}

	function closeOrder() {
		if (!confirm("Stop waiting for the rest?")) return;
		void optimism.change({
			label: `PO ${order.id}`,
			patch: receiveData.patch(order.id, (d) => ({
				...d,
				order: { ...d.order, status: "closed" },
			})),
			send: () => closePurchaseOrder({ data: { id: order.id } }),
		});
		void navigate({ to: "/receive" });
	}

	return (
		<main className="mx-auto min-h-svh max-w-xl bg-background px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
			<header className="sticky top-0 z-10 -mx-4 flex items-center gap-3 bg-background px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
				<Link
					to="/receive"
					aria-label="Back"
					className="flex size-14 shrink-0 items-center justify-center rounded-full bg-card shadow-card active:bg-surface-strong"
				>
					<ArrowLeft className="size-7" />
				</Link>
				<div className="min-w-0">
					<h1 className="truncate text-2xl leading-tight font-bold">
						{supplier.name}
					</h1>
					<p className="text-lg leading-tight text-muted-foreground">
						PO {order.id}
						<Saving className="ml-3 text-base text-muted-foreground" />
					</p>
				</div>
			</header>

			{allDone ? (
				<div className="mb-3 flex flex-col items-center gap-4 rounded-2xl bg-success-fill p-6 text-center text-success-text">
					<Check className="size-16" strokeWidth={3} />
					<p className="text-3xl font-bold">All received</p>
					<Link
						to="/receive"
						className="flex h-16 w-full items-center justify-center rounded-2xl bg-primary text-xl font-bold text-white active:bg-primary-hover"
					>
						Back to list
					</Link>
					<p className="text-base">Tap a line to undo</p>
				</div>
			) : open ? (
				<p className="mb-3 text-center text-base text-muted-foreground">
					Hold a button for a different amount
				</p>
			) : (
				<p className="mb-3 rounded-2xl bg-warning-surface p-4 text-center text-lg font-semibold text-warning-text">
					{order.status === "closed"
						? "Closed. Tap a line to undo."
						: `PO ${order.status}`}
				</p>
			)}

			<ul className="flex flex-col gap-3">
				{sorted.map((line) => (
					<LineRow
						key={line.id}
						line={line}
						locked={!undoable}
						canReceive={open}
						onReceive={(quantity) => receive(line, quantity)}
						onHold={() => setSheetLineId(line.id)}
						onNote={() => setNoteLineId(line.id)}
						damaged={damagedOn(line)}
					/>
				))}
			</ul>

			{undoable && (
				<button
					type="button"
					onClick={() => setExtra({ step: "find" })}
					className="mt-4 flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-card text-xl font-bold shadow-card active:bg-surface-strong"
				>
					<PackagePlus className="size-7" />
					Something else came
				</button>
			)}

			{open && !allDone && (
				<button
					type="button"
					onClick={closeOrder}
					className="mx-auto mt-8 flex h-12 items-center rounded-xl px-5 text-base font-semibold text-muted-foreground active:bg-surface-strong"
				>
					Close PO
				</button>
			)}

			{undoable && sheetLine && (
				<QuantitySheet
					key={sheetLine.id}
					title={productName(sheetLine)}
					unit={sheetLine.packSize === 1 ? undefined : sheetLine.unit}
					canReceive={open}
					remaining={Math.max(sheetLine.quantity - sheetLine.received, 0)}
					lastReceipt={
						receipts.find((r) => ids.same(r.lineId, sheetLine.id))?.quantity ??
						null
					}
					onConfirm={(quantity, last, discount) =>
						receive(sheetLine, quantity, last, discount)
					}
					onDamaged={
						damageable(sheetLine) > 0
							? () => {
									setSheetLineId(null);
									setDamageLineId(sheetLine.id);
								}
							: undefined
					}
					onNoneCame={() => noneCame(sheetLine)}
					onUndo={() => {
						const last = receipts.find((r) => ids.same(r.lineId, sheetLine.id));
						if (!last) return;
						setSheetLineId(null);
						void undoReceipt(order.id, last, productName(sheetLine));
					}}
					onClose={() => setSheetLineId(null)}
				/>
			)}

			{undoable && damageLine && (
				<DamageSheet
					key={damageLine.id}
					title={productName(damageLine)}
					lineId={damageLine.id}
					available={damageable(damageLine)}
					unit={damageLine.packSize === 1 ? undefined : damageLine.unit}
					onClose={() => setDamageLineId(null)}
				/>
			)}
			{undoable && noteLine && (
				<NoteSheet
					key={noteLine.id}
					title={productName(noteLine)}
					note={noteLine.receivingNote}
					onSave={(note) => saveNote(noteLine, note)}
					onClose={() => setNoteLineId(null)}
				/>
			)}

			{extra?.step === "find" && (
				<ExtraSheet
					purchaseOrderId={order.id}
					onPick={pickExtra}
					onClose={() => setExtra(null)}
				/>
			)}
			{extra?.step === "count" && (
				<QuantitySheet
					key={`extra${extra.match.productId}`}
					title={productName(extra.match)}
					unit={
						extra.match.packSize && extra.match.packSize > 1
							? (extra.match.unit ?? undefined)
							: undefined
					}
					canReceive
					remaining={0}
					extra={extra.match.lineId === null}
					lastReceipt={null}
					onConfirm={(quantity, _last, discount) =>
						receiveExtra(extra.match, quantity, discount)
					}
					onUndo={() => {}}
					onClose={() => setExtra(null)}
				/>
			)}
		</main>
	);
}
