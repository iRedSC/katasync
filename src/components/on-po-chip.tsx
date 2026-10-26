import { Link } from "@tanstack/react-router";
import { Truck } from "lucide-react";
import { HoverCard } from "radix-ui";
import { formatCount, formatDay } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { OpenPo } from "#/purchasing/open-pos";

// The other POs a product is already on, beside its SKU, so it isn't bought
// twice. Blue when it's coming on sent POs, amber when another draft has it
// too. Hovering lists them, each opening its PO. On a PO's page the server
// leaves that PO out (otherPos). Nothing when there are none.
export function OnPoChip({ pos: others }: { pos: OpenPo[] }) {
	if (others.length === 0) return null;
	const onDraft = others.some((p) => p.status === "draft");
	const label =
		others.length === 1
			? `PO ${others[0].purchaseOrderId}`
			: `${formatCount(others.length)} POs`;
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<button
					type="button"
					aria-label={`On ${label}. Show`}
					// The row behind opens the product; this only explains.
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"inline-flex h-4 shrink-0 cursor-help items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap tabular-nums outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
						onDraft
							? "bg-warning-surface text-warning-text"
							: "bg-info-surface text-info-text",
					)}
				>
					<Truck className="size-3" aria-hidden />
					{label}
				</button>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					onClick={(e) => e.stopPropagation()}
					className="z-50 flex w-72 flex-col gap-1 rounded-xl bg-popover p-2 text-sm text-popover-foreground shadow-lg ring-1 ring-black/10"
				>
					{others.map((p) => (
						<Link
							key={p.purchaseOrderId}
							to="/purchasing/$id"
							params={{ id: String(p.purchaseOrderId) }}
							className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 hover:bg-subtle"
						>
							<span className="font-medium whitespace-nowrap">
								PO {p.purchaseOrderId}
							</span>
							<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
								{p.supplierName} ·{" "}
								{p.status === "draft"
									? "draft"
									: p.backOrdered
										? "back-ordered"
										: p.expectedAt
											? `due ${formatDay(p.expectedAt)}`
											: "sent"}
							</span>
							<span className="font-medium tabular-nums">
								{formatCount(p.units)}
							</span>
						</Link>
					))}
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}
