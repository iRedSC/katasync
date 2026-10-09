import { Link } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { formatDateTime, formatDelta, formatReason } from "#/lib/format";

const variants = {
	simple: "secondary",
	kit: "outline",
	bundle: "default",
} as const;

export function KindBadge({ kind }: { kind: "simple" | "kit" | "bundle" }) {
	return (
		<Badge variant={variants[kind]} className="capitalize">
			{kind}
		</Badge>
	);
}

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
			className={`${className} shrink-0 rounded-md border bg-white object-contain`}
		/>
	) : (
		<div className={`${className} shrink-0 rounded-md border bg-muted`} />
	);
}

export function ProductLink({ sku }: { sku: string }) {
	return (
		<Link
			to="/products/$sku"
			params={{ sku }}
			className="font-mono text-xs hover:underline"
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
							className={`text-right font-medium tabular-nums ${m.delta < 0 ? "text-destructive" : "text-emerald-600"}`}
						>
							{formatDelta(m.delta)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
