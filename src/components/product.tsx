import { Link } from "@tanstack/react-router";
import { ImageIcon } from "lucide-react";
import { formatDateTime, formatDelta, formatReason } from "#/lib/format";
import { cn } from "#/lib/utils";

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
		return <p className="px-4 pb-4 text-muted-foreground">No changes yet.</p>;
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
