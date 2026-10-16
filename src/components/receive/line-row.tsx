import { Check, ImageOff } from "lucide-react";
import { formatUnit } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { PurchaseOrderDetail } from "#/server/purchasing";
import { holdable, useLongPress } from "./use-long-press";

export type ReceiveLine = PurchaseOrderDetail["lines"][number];

// One product on the PO. Tap the big button to receive what's left; hold it
// for a different amount. Finished lines, and every line of a closed PO, open
// the sheet on a tap instead, so a mistake can still be undone.
export function LineRow({
	line,
	locked,
	canReceive,
	busy,
	receiving,
	onReceive,
	onHold,
}: {
	line: ReceiveLine;
	// No button at all: nothing can be received or undone.
	locked: boolean;
	// The PO is waiting on a delivery.
	canReceive: boolean;
	// Some request is in flight; nothing can be tapped until it lands.
	busy: boolean;
	// This line's request is the one in flight.
	receiving: boolean;
	onReceive: (quantity: number) => void;
	onHold: () => void;
}) {
	const remaining = Math.max(line.quantity - line.received, 0);
	// Counted in what the supplier ships: cases, when it comes in cases.
	const unit = line.packSize === 1 ? "" : ` ${line.unit}`;
	const done = remaining === 0 || !canReceive;
	const press = useLongPress({
		disabled: busy,
		onPress: () => (done ? onHold() : onReceive(remaining)),
		onLongPress: onHold,
	});

	return (
		<li className="rounded-2xl bg-card p-3 shadow-card">
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
					{line.sentQuantity === null ? (
						<p className="text-sm font-semibold text-warning-text">
							Added after sending
						</p>
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
					{line.packSize !== 1 && (
						<p className="text-base font-semibold text-muted-foreground">
							{formatUnit(line.unit, line.packSize)}
						</p>
					)}
				</div>
			</div>

			{!locked && (
				<button
					type="button"
					disabled={busy}
					{...press}
					className={cn(
						holdable,
						"mt-3 flex h-16 w-full items-center justify-center gap-2 rounded-2xl text-xl font-bold",
						done
							? "bg-success-fill text-success-text opacity-60"
							: "bg-primary text-primary-foreground active:bg-primary-hover",
						busy && "opacity-40",
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
					) : receiving ? (
						"Receiving…"
					) : (
						`Receive ${remaining}${unit}`
					)}
				</button>
			)}
		</li>
	);
}
