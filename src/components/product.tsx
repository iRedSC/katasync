import { Link } from "@tanstack/react-router";
import { ImageIcon, LayersIcon } from "lucide-react";
import { HoverCard } from "radix-ui";
import {
	formatCount,
	formatDateTime,
	formatDelta,
	formatReason,
} from "#/lib/format";
import { cn } from "#/lib/utils";
import { DEMAND_DAYS } from "#/purchasing/forecast";
import {
	partRole,
	type SetMembership,
	setsBlocked,
	setsLimited,
} from "#/purchasing/sets";

export function ProductImage({
	src,
	className = "size-10",
}: {
	src: string | null;
	className?: string;
}) {
	return src ? (
		<img
			src={src}
			alt=""
			loading="lazy"
			className={cn(
				className,
				"shrink-0 rounded-lg border bg-white object-contain",
			)}
		/>
	) : (
		// No photo yet: Shopify's placeholder look rather than an empty box.
		<div
			className={cn(
				className,
				"flex shrink-0 items-center justify-center rounded-lg border bg-subtle text-faint",
			)}
		>
			<ImageIcon className="size-1/2" strokeWidth={1.5} />
		</div>
	);
}

export function ProductLink({ sku }: { sku: string }) {
	return (
		<Link
			to="/products/$sku"
			params={{ sku }}
			className="text-link hover:underline"
		>
			{sku}
		</Link>
	);
}

// A product's name with its variant as a quiet chip, e.g. "Flat Box [12 x 9]".
export function ProductName({
	name,
	variantName,
}: {
	name: string;
	variantName: string | null;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span className="truncate font-medium">{name}</span>
			{variantName && (
				<span className="shrink-0 rounded-md bg-surface px-1.5 text-xs text-muted-foreground">
					{variantName}
				</span>
			)}
		</span>
	);
}

// How many tool sets a product is a part of, beside its SKU. Red when its
// shelf can't build one of some of them. Hovering lists the sets as
// products, with how many can be sold and how many sold. Nothing when it's in
// none.
export function SetsChip({ sets }: { sets: SetMembership | null }) {
	if (!sets || sets.sets.length === 0) return null;
	const blocked = setsBlocked(sets);
	return (
		<HoverCard.Root openDelay={150} closeDelay={100}>
			<HoverCard.Trigger asChild>
				<button
					type="button"
					aria-label={`In ${formatCount(sets.sets.length)} tool ${sets.sets.length === 1 ? "set" : "sets"}. Show them`}
					// The row behind opens the product; this only explains.
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"inline-flex h-4 shrink-0 cursor-help items-center gap-1 rounded-md px-1.5 text-[11px] font-medium tabular-nums outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring",
						blocked > 0
							? "bg-critical-fill text-critical-text"
							: "bg-surface text-muted-foreground",
					)}
				>
					<LayersIcon className="size-3" aria-hidden />
					{formatCount(sets.sets.length)}
				</button>
			</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					onClick={(e) => e.stopPropagation()}
					className="z-50 flex max-h-(--radix-hover-card-content-available-height) w-[26rem] flex-col gap-3 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-black/10"
				>
					<SetsList sets={sets} />
				</HoverCard.Content>
			</HoverCard.Portal>
		</HoverCard.Root>
	);
}

function SetsList({ sets }: { sets: SetMembership }) {
	const count = sets.sets.length;
	const blocked = setsBlocked(sets);
	const limited = setsLimited(sets) - blocked;
	return (
		<>
			<div>
				<p className="text-base leading-snug font-semibold">
					In {formatCount(count)} tool {count === 1 ? "set" : "sets"}
				</p>
				<p className="text-xs text-muted-foreground">
					{formatCount(sets.shelf)} on the shelf
					{blocked > 0 && (
						<span className="text-critical-text">
							{" · "}Blocks {formatCount(blocked)}
						</span>
					)}
					{limited > 0 && <> · Limits {formatCount(limited)}</>}
				</p>
			</div>
			<div className="-mx-4 flex min-h-0 flex-col overflow-y-auto">
				<div className="flex gap-3 border-b px-4 pb-1 text-xs font-medium text-muted-foreground">
					<span className="flex-1">Set</span>
					<span className="w-14 text-right">Sellable</span>
					<span className="w-14 text-right">Sold {DEMAND_DAYS}d</span>
				</div>
				{sets.sets.map((set) => {
					const role = partRole(sets, set);
					return (
						<Link
							key={set.sku}
							to="/products/$sku"
							params={{ sku: set.sku }}
							className="flex items-center gap-3 border-b px-4 py-2 last:border-b-0 hover:bg-subtle"
						>
							<ProductImage src={set.imageUrl} className="size-8" />
							<div className="min-w-0 flex-1">
								<ProductName name={set.name} variantName={set.variantName} />
								<div className="flex gap-2 text-xs text-muted-foreground">
									<span>{set.sku}</span>
									{set.perSet > 1 && <span>× {formatCount(set.perSet)}</span>}
								</div>
							</div>
							<span
								className={cn(
									"w-14 text-right tabular-nums",
									role === "blocks"
										? "font-semibold text-critical-text"
										: role === "limits"
											? "font-semibold"
											: "text-muted-foreground",
								)}
							>
								{formatCount(set.sellable)}
							</span>
							<span
								className={cn(
									"w-14 text-right tabular-nums",
									set.sold === 0 && "text-faint",
								)}
							>
								{formatCount(set.sold)}
							</span>
						</Link>
					);
				})}
			</div>
		</>
	);
}

type MovementRow = {
	id: number;
	createdAt: Date;
	location: string;
	delta: number;
	reason: string;
	reference: string | null;
	note: string | null;
};

// Index-table look: gray header row, hairline row dividers.
export function MovementTable({ rows }: { rows: MovementRow[] }) {
	if (rows.length === 0) {
		return <p className="px-4 pb-4 text-muted-foreground">No changes.</p>;
	}
	return (
		<table className="w-full">
			<thead>
				<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
					<th className="px-4 py-2 font-medium">Date</th>
					<th className="px-4 py-2 font-medium">Reason</th>
					<th className="px-4 py-2 font-medium">Location</th>
					<th className="px-4 py-2 text-right font-medium">Change</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((m) => (
					<tr key={m.id} className="border-t first:border-t-0">
						<td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
							{formatDateTime(m.createdAt)}
						</td>
						<td className="px-4 py-2.5">
							{formatReason(m.reason)}
							{(m.note ?? m.reference) && (
								<div className="text-xs text-muted-foreground">
									{m.note ?? m.reference}
								</div>
							)}
						</td>
						<td className="px-4 py-2.5">{m.location}</td>
						<td
							className={cn(
								"px-4 py-2.5 text-right font-semibold tabular-nums",
								m.delta < 0 ? "text-critical-text" : "text-success-text",
							)}
						>
							{formatDelta(m.delta)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
