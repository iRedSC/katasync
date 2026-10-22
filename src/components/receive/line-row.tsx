import { Check, ImageOff, NotebookPen } from "lucide-react";
import { formatUnit } from "#/lib/format";
import { cn } from "#/lib/utils";
import { isBackOrdered } from "#/purchasing/status";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { holdable, useLongPress } from "./use-long-press";

// What the receive page shows of a line. Narrower than the PO's line, so a line
// that's only on this page (an extra, before the reload) can be made from a
// search match.
export type ReceiveLine = Pick<
	PurchaseOrderDetail["lines"][number],
	| "id"
	| "productId"
	| "sku"
	| "name"
	| "variantName"
	| "imageUrl"
	| "unit"
	| "packSize"
	| "supplierCount"
	| "quantity"
	| "received"
	| "sentQuantity"
	| "receivingNote"
	| "backOrderedAt"
>;

// One product on the PO. Tap the big button to receive what's left; hold it
// for a different amount. Finished lines, and every line of a closed PO, open
// the sheet on a tap instead, so a mistake can still be undone. A note, from
// whoever unpacked it or Claude, sits above the line; the pen beside the
// button writes one.
export function LineRow({
	line,
	locked,
	canReceive,
	onReceive,
	onHold,
	onNote,
	damaged,
	missing,
}: {
	line: ReceiveLine;
	// Single items recorded as damaged, and as missing from what came.
	damaged: number;
	missing: number;
	// No button at all: nothing can be received or undone.
	locked: boolean;
	// The PO is waiting on a delivery.
	canReceive: boolean;
	onReceive: (quantity: number) => void;
	onHold: () => void;
	onNote: () => void;
}) {
	const remaining = Math.max(line.quantity - line.received, 0);
	// Counted in what the supplier ships: cases, when it comes in cases.
	const unit = line.packSize === 1 ? "" : ` ${line.unit}`;
	const done = remaining === 0 || !canReceive;
	const press = useLongPress({
		onPress: () => (done ? onHold() : onReceive(remaining)),
		onLongPress: onHold,
	});

	return (
		<li className="rounded-2xl bg-card p-3 shadow-card">
			{line.receivingNote &&
				(locked ? (
					<p className="mb-3 rounded-xl bg-warning-surface px-3 py-2 text-base whitespace-pre-wrap text-warning-text">
						{line.receivingNote}
					</p>
				) : (
					<button
						type="button"
						onClick={onNote}
						className="mb-3 block w-full rounded-xl bg-warning-surface px-3 py-2 text-left text-base whitespace-pre-wrap text-warning-text active:opacity-80"
					>
						{line.receivingNote}
					</button>
				))}
			<div className={cn("flex items-center gap-3", done && "opacity-60")}>
				{line.imageUrl ? (
					<img
						src={line.imageUrl}
						alt=""
						className="size-16 shrink-0 rounded-xl bg-surface-strong object-cover"
					/>
				) : (
					<div className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-surface-strong text-faint">
						<ImageOff className="size-6" />
					</div>
				)}
				<div className="min-w-0 flex-1">
					<p className="line-clamp-2 text-lg leading-snug font-semibold">
						{line.name}
					</p>
					{line.variantName && (
						<p className="truncate text-base text-muted-foreground">
							{line.variantName}
						</p>
					)}
					<p className="truncate font-mono text-xs text-muted-foreground">
						{line.sku}
					</p>
					{isBackOrdered(line) && (
						<p className="text-sm font-semibold text-warning-text">
							Back-ordered
						</p>
					)}
					{(damaged > 0 || missing > 0) && (
						<p className="text-sm font-semibold text-critical-text">
							{[
								damaged > 0 && `${damaged} damaged`,
								missing > 0 && `${missing} missing`,
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					)}
					{line.sentQuantity === null ? (
						<p className="text-sm font-semibold text-info-text">Amended</p>
					) : (
						line.sentQuantity !== line.quantity && (
							<p className="text-sm font-semibold text-warning-text">
								Ordered {line.sentQuantity}
							</p>
						)
					)}
				</div>
				<div className="shrink-0 text-right">
					<p className="text-2xl font-bold tabular-nums">
						{line.received} / {line.quantity}
					</p>
					{(line.packSize !== 1 || line.supplierCount !== 1) && (
						<p className="text-base font-semibold text-muted-foreground">
							{formatUnit(line)}
						</p>
					)}
				</div>
			</div>

			{!locked && (
				<div className="mt-3 flex gap-2">
					<button
						type="button"
						{...press}
						className={cn(
							holdable,
							"flex h-16 flex-1 items-center justify-center gap-2 rounded-2xl text-xl font-bold",
							done
								? "bg-success-fill text-success-text opacity-60"
								: "bg-primary text-primary-foreground active:bg-primary-hover",
						)}
					>
						{done ? (
							line.quantity === 0 && line.received === 0 ? (
								"None came"
							) : remaining === 0 ? (
								<>
									<Check className="size-7" strokeWidth={3} />
									Done
								</>
							) : (
								`${remaining}${unit} never came`
							)
						) : (
							`Receive ${remaining}${unit}`
						)}
					</button>
					<button
						type="button"
						onClick={onNote}
						aria-label={line.receivingNote ? "Edit note" : "Add note"}
						className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-surface text-muted-foreground active:bg-surface-strong"
					>
						<NotebookPen className="size-7" />
					</button>
				</div>
			)}
		</li>
	);
}
