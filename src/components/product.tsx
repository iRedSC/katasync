import { Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
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
			className={cn(className, "shrink-0 rounded-lg bg-white object-contain")}
		/>
	) : (
		// No photo yet: a quiet stand-in rather than an empty box.
		<div
			className={cn(
				className,
				"flex shrink-0 items-center justify-center rounded-lg bg-deep text-haze/40",
			)}
		>
			<Package className="size-1/2" strokeWidth={1.5} />
		</div>
	);
}

export function ProductLink({ sku }: { sku: string }) {
	return (
		<Link
			to="/products/$sku"
			params={{ sku }}
			className="text-xs text-muted-foreground hover:text-foreground"
		>
			{sku}
		</Link>
	);
}

export function MovementTable({
	rows,
}: {
	rows: {
		id: number;
		createdAt: Date;
		location: string;
		delta: number;
		reason: string;
		reference: string | null;
		note: string | null;
		sku?: string;
	}[];
}) {
	if (rows.length === 0) {
		return <p className="text-sm text-muted-foreground">No movements yet.</p>;
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>When</TableHead>
					{rows[0].sku !== undefined && <TableHead>SKU</TableHead>}
					<TableHead>Reason</TableHead>
					<TableHead>Location</TableHead>
					<TableHead>Reference</TableHead>
					<TableHead className="text-right">Change</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((m) => (
					<TableRow key={m.id}>
						<TableCell className="whitespace-nowrap text-muted-foreground">
							{formatDateTime(m.createdAt)}
						</TableCell>
						{m.sku !== undefined && (
							<TableCell>
								<ProductLink sku={m.sku} />
							</TableCell>
						)}
						<TableCell>
							{formatReason(m.reason)}
							{m.note && (
								<div className="text-xs text-muted-foreground">{m.note}</div>
							)}
						</TableCell>
						<TableCell>{m.location}</TableCell>
						<TableCell className="text-muted-foreground">
							{m.reference ?? "—"}
						</TableCell>
						<TableCell
							className={`text-right font-medium tabular-nums ${m.delta < 0 ? "text-bad-ink" : "text-good-ink"}`}
						>
							{formatDelta(m.delta)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
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
			<span className="truncate">{name}</span>
			{variantName && (
				<span className="shrink-0 rounded-md bg-dusk px-1.5 py-0.5 text-xs text-muted-foreground">
					{variantName}
				</span>
			)}
		</span>
	);
}
