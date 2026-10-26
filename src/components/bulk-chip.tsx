import { Tags } from "lucide-react";
import { HoverCard } from "radix-ui";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { nextBreak, type PriceList, priceAt } from "#/purchasing/bulk";

// A supplier's bulk prices as a chip beside a product, like SetsChip:
// hovering lists them. Given the order's quantity, the one it pays is marked
// and the chip goes red when a cheaper one is close; `onOrder` then offers
// to order that many.
export function BulkChip({
	list,
	unit,
	order,
	onOrder,
}: {
	list: PriceList;
	unit: string;
	order?: { quantity: number; unitCost: number | null };
	onOrder?: (quantity: number) => void;
}) {
	if (list.breaks.length === 0) return null;
	const next = order ? nextBreak(list, order.quantity, order.unitCost) : null;
	const close = next?.close ?? false;
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<button
					type="button"
					aria-label={
						close && next
							? `${formatCount(next.more)} more for ${formatMoney(next.cost)} each. Show bulk prices`
							: "Show bulk prices"
					}
					// The row behind opens the product; this only explains.
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"inline-flex h-4 shrink-0 cursor-help items-center gap-1 rounded-md px-1.5 text-[11px] font-medium tabular-nums outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
						close
							? "bg-critical-fill text-critical-text"
							: "bg-surface text-muted-foreground",
					)}
				>
					<Tags className="size-3" aria-hidden />
					{close && next
						? `+${formatCount(next.more)}`
						: formatCount(list.breaks.length)}
				</button>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					onClick={(e) => e.stopPropagation()}
					className="z-50 flex w-64 flex-col gap-3 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-black/10"
				>
					<BreakList list={list} unit={unit} quantity={order?.quantity} />
					{next && (
						<div className="flex items-center gap-2 border-t pt-3">
							<p
								className={cn(
									"flex-1 text-xs",
									close ? "text-critical-text" : "text-muted-foreground",
								)}
							>
								{formatCount(next.more)} more for {formatMoney(next.cost)} each
								{next.extra !== null &&
									(next.extra <= 0
										? `, ${formatMoney(-next.extra)} less in all`
										: `, ${formatMoney(next.extra)} more in all`)}
							</p>
							{onOrder && (
								<button
									type="button"
									onClick={() => onOrder(next.minQuantity)}
									className="shrink-0 cursor-pointer rounded-md bg-surface px-2 py-1 text-xs font-medium hover:bg-surface-strong"
								>
									Order {formatCount(next.minQuantity)}
								</button>
							)}
						</div>
					)}
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

// Each price from the fewest units it starts at, the price itself first.
// The one `quantity` pays is bold.
export function BreakList({
	list,
	unit,
	quantity,
}: {
	list: PriceList;
	unit: string;
	quantity?: number;
}) {
	const paid = quantity === undefined ? null : priceAt(list, quantity);
	const rows = [
		{ minQuantity: 1, cost: list.cost },
		...list.breaks.map((b) => ({ minQuantity: b.minQuantity, cost: b.cost })),
	];
	// The one paying: the most units it reaches at the price paid.
	const at =
		quantity === undefined
			? -1
			: rows.reduce(
					(found, r, i) =>
						r.minQuantity <= quantity && r.cost === paid ? i : found,
					-1,
				);
	return (
		<div>
			<p className="mb-1.5 font-semibold">Bulk prices</p>
			<div className="flex gap-3 text-xs text-muted-foreground">
				<span className="flex-1">{unit}</span>
				<span>Each</span>
			</div>
			{rows.map((r, i) => (
				<div
					key={r.minQuantity}
					className={cn(
						"flex gap-3 tabular-nums",
						i === at ? "font-semibold" : "text-muted-foreground",
					)}
				>
					<span className="flex-1">{formatCount(r.minQuantity)}+</span>
					<span>{formatMoney(r.cost)}</span>
				</div>
			))}
		</div>
	);
}
