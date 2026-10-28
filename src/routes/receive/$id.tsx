import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, PackageCheck, PackagePlus } from "lucide-react";
import { useMemo, useState } from "react";
import type { DamageKind } from "#/components/damage/damage";
import type { PurchaseOrderMatch } from "#/components/po-search";
import { DamageSheet } from "#/components/receive/damage-sheet";
import { ExtraSheet } from "#/components/receive/extra-sheet";
import { LineRow, type ReceiveLine } from "#/components/receive/line-row";
import { NoteSheet } from "#/components/receive/note-sheet";
import { receiveHead } from "#/components/receive/pwa";
import {
	QuantitySheet,
	type ReceiptDiscount,
} from "#/components/receive/quantity-sheet";
import {
	afterReceive,
	afterUndo,
	blankLine,
	changeBackOrdered,
	changeNote,
	done,
	expectPatch,
	extraPatch,
	productName,
	receiptFor,
	receiveAll,
	receiveData,
	receivePatch,
	said,
	undoReceipt,
} from "#/components/receive/receive-data";
import { Saving } from "#/components/saving";
import { ReceiveSkeleton } from "#/components/skeleton";
import { groupBy } from "#/lib/group-by";
import { ids, optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { isBackOrdered, takenByReceiveAll } from "#/purchasing/status";
import {
	amendPurchaseLine,
	closePurchaseOrder,
	receiveExtraLine,
	receiveLine,
} from "#/server/purchasing";
import { getReceivePurchaseOrder } from "#/server/purchasing/detail";

export const Route = createFileRoute("/receive/$id")({
	head: receiveHead,
	loader: ({ params }) =>
		getReceivePurchaseOrder({ data: { id: Number(params.id) } }),
	component: ReceivePurchaseOrder,
	pendingComponent: () => <ReceiveSkeleton />,
});

function ReceivePurchaseOrder() {
	const loaded = Route.useLoaderData();
	const d = receiveData.useData(loaded.order.id, loaded);
	const navigate = useNavigate();
	const { order, supplier, lines, receipts } = d;
	// Damage by line, grouped once per data version rather than scanned per row.
	const damagesByLine = useMemo(
		() => groupBy(d.damages, (r) => r.lineId),
		[d.damages],
	);
	const [sheetLineId, setSheetLineId] = useState<number | null>(null);
	const [noteLineId, setNoteLineId] = useState<number | null>(null);
	const [damaging, setDamaging] = useState<{
		lineId: number;
		kind: DamageKind;
	} | null>(null);
	// Single items of a line recorded as damaged or missing, and what could
	// still be.
	const damagedOn = (l: ReceiveLine, kind?: DamageKind) =>
		(damagesByLine.get(ids.current(l.id)) ?? [])
			.filter((x) => kind === undefined || x.kind === kind)
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
	const receivingAll = open ? lines.filter(takenByReceiveAll).length : 0;
	// Unfinished lines first, then back-ordered ones, which this box likely
	// doesn't have; the rest sink to the bottom.
	const sorted = [
		...lines.filter((l) => !done(l) && !isBackOrdered(l)),
		...lines.filter(isBackOrdered),
		...lines.filter(done),
	];
	const sheetLine =
		sheetLineId === null
			? undefined
			: lines.find((l) => ids.same(l.id, sheetLineId));
	const damageLine =
		damaging === null
			? undefined
			: lines.find((l) => ids.same(l.id, damaging.lineId));
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
		// One per receipt, so a resend can't receive it twice.
		const key = crypto.randomUUID();
		const r = await optimism.change({
			label: `Receiving ${name}`,
			patch: receivePatch(order.id, line.id, receipt, last),
			send: async () => {
				const result = await receiveLine({
					data: { key, lineId: ids.server(line.id), quantity, last, discount },
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

	// Everything left came, but what's back-ordered. One undo takes it all back.
	async function receiveEverything() {
		navigator.vibrate?.(10);
		const r = await receiveAll(order.id, lines);
		if (!r) return;
		offerUndo(`Received ${r.lines} ${r.lines === 1 ? "line" : "lines"}`, {
			tone: "success",
			undo: async () => {
				const u = await r.undo();
				return u && "Took them back";
			},
		});
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

	// True once the server has it; the sheet stays open until then.
	async function saveNote(line: ReceiveLine, note: string | null) {
		const name = productName(line);
		const was = line.receivingNote;
		const r = await changeNote(order.id, line, note, `Note on ${name}`);
		if (!r) return false;
		offerUndo(note === null ? `Removed the note on ${name}` : `Noted ${name}`, {
			undo: async () => {
				const u = await changeNote(order.id, line, was, `Note on ${name}`);
				return u && `Put the note on ${name} back`;
			},
		});
		return true;
	}

	async function backOrder(line: ReceiveLine, backOrdered: boolean) {
		setSheetLineId(null);
		const name = productName(line);
		const r = await changeBackOrdered(order.id, line, backOrdered);
		if (!r) return;
		offerUndo(
			backOrdered ? `${name} back-ordered` : `${name} no longer back-ordered`,
			{
				undo: async () => {
					const u = await changeBackOrdered(order.id, line, !backOrdered);
					return u && `Put ${name} back as it was`;
				},
			},
		);
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
		const key = crypto.randomUUID();
		const r = await optimism.change({
			label: `Receiving ${name}`,
			patch: extraPatch(order.id, match, receipt),
			send: async () => {
				const result = await receiveExtraLine({
					data: {
						key,
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
				<>
					{receivingAll > 1 && (
						<button
							type="button"
							onClick={receiveEverything}
							className="mb-3 flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-card text-xl font-bold shadow-card active:bg-surface-strong"
						>
							<PackageCheck className="size-7" />
							Receive all
						</button>
					)}
					<p className="mb-3 text-center text-base text-muted-foreground">
						Hold a button for a different amount
					</p>
				</>
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
						damaged={damagedOn(line, "damaged")}
						missing={damagedOn(line, "missing")}
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
							? (kind) => {
									setSheetLineId(null);
									setDamaging({ lineId: sheetLine.id, kind });
								}
							: undefined
					}
					onNoneCame={() => noneCame(sheetLine)}
					backOrdered={isBackOrdered(sheetLine)}
					onBackOrdered={(b) => backOrder(sheetLine, b)}
					onUndo={() => {
						const last = receipts.find((r) => ids.same(r.lineId, sheetLine.id));
						if (!last) return;
						setSheetLineId(null);
						void undoReceipt(order.id, last, productName(sheetLine));
					}}
					onClose={() => setSheetLineId(null)}
				/>
			)}

			{undoable && damageLine && damaging && (
				<DamageSheet
					key={damageLine.id}
					title={productName(damageLine)}
					kind={damaging.kind}
					lineId={damageLine.id}
					available={damageable(damageLine)}
					unit={damageLine.packSize === 1 ? undefined : damageLine.unit}
					onClose={() => setDamaging(null)}
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
