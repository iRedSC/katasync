import { Link } from "@tanstack/react-router";
import { ImageIcon, LayersIcon } from "lucide-react";
import { Tip } from "#/components/ui/tooltip";
import {
	formatCount,
	formatDateTime,
	formatDelta,
	formatReason,
} from "#/lib/format";
import { cn } from "#/lib/utils";
import type { SetMembership } from "#/purchasing/sets";

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

// How many tool sets a product is a part of, for beside its SKU. Red when
// its shelf leaves some of them unsellable; nothing when it's in none.
export function SetsChip({ sets }: { sets: SetMembership | null }) {
	if (!sets || sets.in === 0) return null;
	const noun = (n: number) => `tool ${n === 1 ? "set" : "sets"}`;
	const title =
		sets.blocked === 0
			? `Part of ${formatCount(sets.in)} ${noun(sets.in)}`
			: `Part of ${formatCount(sets.in)} ${noun(sets.in)}; too few on the shelf to build ${sets.blocked === sets.in ? (sets.in === 1 ? "it" : "any of them") : `${formatCount(sets.blocked)} of them`}`;
	return (
		<Tip content={title}>
			<span
				className={cn(
					"inline-flex h-4 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium tabular-nums",
					sets.blocked > 0
						? "bg-critical-fill text-critical-text"
						: "bg-surface text-muted-foreground",
				)}
			>
				<LayersIcon className="size-3" aria-hidden />
				<span aria-hidden>
					{sets.blocked > 0
						? `${formatCount(sets.blocked)}/${formatCount(sets.in)}`
						: formatCount(sets.in)}
				</span>
				<span className="sr-only">{title}</span>
			</span>
		</Tip>
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
