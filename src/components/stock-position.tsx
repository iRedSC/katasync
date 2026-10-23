import { Badge } from "#/components/page";
import type { StockPosition as Position } from "#/inventory/stock-position";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";

function Figure({
	label,
	value,
	tone,
}: {
	label: string;
	value: number;
	tone?: "critical" | "muted";
}) {
	return (
		<div className="flex flex-col">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span
				className={cn(
					"text-lg font-semibold tabular-nums",
					tone === "critical" && "text-critical-text",
					tone === "muted" && "text-muted-foreground",
				)}
			>
				{formatCount(value)}
			</span>
		</div>
	);
}

export function StockPosition({ position }: { position: Position }) {
	if (position.mode === "legacy")
		return (
			<div className="flex items-end gap-6">
				<Figure label="Net of open orders" value={position.net} />
				{position.inTransit !== 0 && (
					<Figure label="In transit" value={position.inTransit} tone="muted" />
				)}
				<Badge tone="info">Physical stock pending activation</Badge>
			</div>
		);
	return (
		<div className="flex items-end gap-6">
			<Figure label="On the shelf" value={position.physical} />
			<Figure label="Reserved" value={position.committed} tone="muted" />
			<Figure
				label={position.shortage > 0 ? "Short" : "Available"}
				value={position.shortage > 0 ? position.shortage : position.available}
				tone={position.shortage > 0 ? "critical" : undefined}
			/>
			{position.inTransit !== 0 && (
				<Figure label="In transit" value={position.inTransit} tone="muted" />
			)}
		</div>
	);
}
