import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ArrowLeft, Check, PackagePlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { PurchaseOrderMatch } from "#/components/po-product-picker";
import { ExtraSheet } from "#/components/receive/extra-sheet";
import { LineRow, type ReceiveLine } from "#/components/receive/line-row";
import { receiveHead } from "#/components/receive/pwa";
import { QuantitySheet } from "#/components/receive/quantity-sheet";
import { offerUndo } from "#/lib/undo";
import {
	amendPurchaseLine,
	closePurchaseOrder,
	getPurchaseOrder,
	receiveExtraLine,
	receiveLine,
	undoPurchaseReceipt,
} from "#/server/purchasing";

export const Route = createFileRoute("/receive/$id")({
	head: receiveHead,
	loader: ({ params }) => getPurchaseOrder({ data: { id: Number(params.id) } }),
	component: ReceivePurchaseOrder,
});

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

const productName = (line: ReceiveLine) =>
	line.variantName ? `${line.name} (${line.variantName})` : line.name;

function ReceivePurchaseOrder() {
	const { order, supplier, lines, receipts } = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	// The line whose request is in flight. Everything is locked meanwhile, so a
	// double tap can't receive twice and a reload can't race a write.
	const [busyLine, setBusyLine] = useState<number | null>(null);
	const [sheetLineId, setSheetLineId] = useState<number | null>(null);
	// Something that isn't on the PO: finding it, then counting it.
	const [extra, setExtra] = useState<
		{ step: "find" } | { step: "count"; match: PurchaseOrderMatch } | null
	>(null);

	const open = order.status === "sent";
	// A closed PO can still take back a mis-tapped receipt, and take
	// something else that was in the box.
	const undoable = open || order.status === "closed";
	const done = (l: ReceiveLine) => l.received >= l.quantity;
	const allDone = lines.length > 0 && lines.every(done);
	// Unfinished lines first; the rest sink to the bottom.
	const sorted = [...lines.filter((l) => !done(l)), ...lines.filter(done)];
	const sheetLine = lines.find((l) => l.id === sheetLineId);

	async function run(lineId: number, work: () => Promise<void>) {
		if (busyLine !== null) return;
		setBusyLine(lineId);
		try {
			await work();
			await router.invalidate();
		} catch (err) {
			toast.error(message(err));
		} finally {
			setBusyLine(null);
		}
	}

	// Not through run: it shows its own errors, and offerUndo needs to see them.
	const undo = async (line: ReceiveLine, receiptId: number) => {
		await undoPurchaseReceipt({ data: { id: receiptId } });
		await router.invalidate();
		return `Undid ${productName(line)}`;
	};

	const receive = (line: ReceiveLine, quantity: number, last = false) =>
		run(line.id, async () => {
			const result = await receiveLine({
				data: { lineId: line.id, quantity, last },
			});
			navigator.vibrate?.(10);
			setSheetLineId(null);
			const unit = line.packSize === 1 ? "" : ` ${line.unit}`;
			const total = line.received + quantity;
			const note =
				total > line.quantity
					? " The PO keeps the extra."
					: last && total < line.quantity
						? " Not waiting for the rest."
						: "";
			offerUndo(`Received ${quantity}${unit} × ${productName(line)}.${note}`, {
				tone: "success",
				undo: () => undo(line, result.receiptId),
			});
		});

	// Stops waiting for what's left of a line, receiving none of it.
	const noneCame = (line: ReceiveLine) =>
		run(line.id, async () => {
			const { was } = await amendPurchaseLine({
				data: { lineId: line.id, quantity: line.received },
			});
			setSheetLineId(null);
			offerUndo(`Not waiting for ${productName(line)}`, {
				undo: async () => {
					await amendPurchaseLine({
						data: { lineId: line.id, quantity: was.quantity },
					});
					await router.invalidate();
					return `Waiting for ${productName(line)} again`;
				},
			});
		});

	function pickExtra(match: PurchaseOrderMatch) {
		// Already on an open PO: count it on its own line. A closed PO takes
		// it as extra, which reopens and settles it in one go.
		if (match.lineId !== null && open) {
			setExtra(null);
			setSheetLineId(match.lineId);
			return;
		}
		setExtra({ step: "count", match });
	}

	const receiveExtra = (match: PurchaseOrderMatch, quantity: number) =>
		run(-match.productId, async () => {
			const result = await receiveExtraLine({
				data: {
					purchaseOrderId: order.id,
					productId: match.productId,
					quantity,
				},
			});
			navigator.vibrate?.(10);
			setExtra(null);
			const name = match.variantName
				? `${match.name} (${match.variantName})`
				: match.name;
			offerUndo(`Added and received ${quantity} × ${name}`, {
				tone: "success",
				undo: async () => {
					await undoPurchaseReceipt({ data: { id: result.receiptId } });
					await router.invalidate();
					return `Undid ${name}`;
				},
			});
		});

	async function closeOrder() {
		if (!confirm("Stop waiting for the rest?")) return;
		try {
			await closePurchaseOrder({ data: { id: order.id } });
			await navigate({ to: "/receive" });
		} catch (err) {
			toast.error(message(err));
		}
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
					<p className="text-base">Tap a line to undo a mistake</p>
				</div>
			) : open ? (
				<p className="mb-3 text-center text-base text-muted-foreground">
					Hold a button for a different amount
				</p>
			) : (
				<p className="mb-3 rounded-2xl bg-warning-surface p-4 text-center text-lg font-semibold text-warning-text">
					{order.status === "closed"
						? "This PO is closed. Tap a line to undo a mistake."
						: `This PO is ${order.status}`}
				</p>
			)}

			<ul className="flex flex-col gap-3">
				{sorted.map((line) => (
					<LineRow
						key={line.id}
						line={line}
						locked={!undoable}
						canReceive={open}
						busy={busyLine !== null}
						receiving={busyLine === line.id}
						onReceive={(quantity) => receive(line, quantity)}
						onHold={() => setSheetLineId(line.id)}
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
						receipts.find((r) => r.lineId === sheetLine.id)?.quantity ?? null
					}
					busy={busyLine !== null}
					onConfirm={(quantity, last) => receive(sheetLine, quantity, last)}
					onNoneCame={() => noneCame(sheetLine)}
					onUndo={() => {
						const last = receipts.find((r) => r.lineId === sheetLine.id);
						if (!last) return;
						setSheetLineId(null);
						undo(sheetLine, last.id);
					}}
					onClose={() => setSheetLineId(null)}
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
					title={
						extra.match.variantName
							? `${extra.match.name} (${extra.match.variantName})`
							: extra.match.name
					}
					unit={
						extra.match.packSize && extra.match.packSize > 1
							? (extra.match.unit ?? undefined)
							: undefined
					}
					canReceive
					remaining={0}
					extra={extra.match.lineId === null}
					lastReceipt={null}
					busy={busyLine !== null}
					onConfirm={(quantity) => receiveExtra(extra.match, quantity)}
					onUndo={() => {}}
					onClose={() => setExtra(null)}
				/>
			)}
		</main>
	);
}
