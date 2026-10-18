import { Badge } from "#/components/page";
import { formatCount, formatOrderQuantity } from "#/lib/format";
import { cn } from "#/lib/utils";
import { stock } from "#/products/rows";
import type { ProductRow } from "#/server/catalog";

// Only problems get a badge. A healthy row stays quiet.
export function RowStatus({ product: p }: { product: ProductRow }) {
	if ((p.onHand ?? 0) < 0) return <Badge tone="critical">Oversold</Badge>;
	if (p.kind === "bundle" && p.available === 0) {
		return <Badge tone="warning">Missing parts</Badge>;
	}
	if (p.available === 0) return <Badge>Sold out</Badge>;
	return null;
}

export function Inventory({ product: p }: { product: ProductRow }) {
	if ((p.onHand ?? 0) < 0) {
		return (
			<span className="font-medium text-critical-text">
				{formatCount(stock(p))} in stock
			</span>
		);
	}
	return (
		<span className={cn(p.available === 0 && "text-muted-foreground")}>
			{formatCount(p.available)}{" "}
			{p.kind === "bundle" ? "can be built" : "in stock"}
		</span>
	);
}

// The suggested order, or the line already waiting on a draft.
export function Reorder({ product: p }: { product: ProductRow }) {
	if (p.draft) {
		return (
			<span className="text-muted-foreground">
				{formatOrderQuantity(p.draft)} on PO {p.draft.purchaseOrderId}
			</span>
		);
	}
	if (p.reorder) {
		return (
			<span className="font-medium">{formatOrderQuantity(p.reorder)}</span>
		);
	}
	return null;
}
