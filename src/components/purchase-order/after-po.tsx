import { ArrowRight } from "lucide-react";
import { StockRing } from "#/components/stock-ring";
import { afterArrival } from "#/inventory/stock-state";
import type { Line } from "./types";

// On hand, and what it comes to once the draft arrives: the product's own
// line plus any set parts of it, as sending will merge them.
export function AfterPo({
	onHand,
	range,
	ordered,
}: {
	onHand: number;
	range: Line["stockRange"];
	ordered: number;
}) {
	if (!range)
		return <span className="block text-center text-muted-foreground">—</span>;
	return (
		<div className="flex items-center justify-center gap-1">
			<StockRing onHand={onHand} range={range} />
			<ArrowRight
				className="size-4 text-muted-foreground"
				strokeWidth={2.5}
				aria-hidden="true"
			/>
			<StockRing
				onHand={afterArrival(onHand, ordered)}
				range={range}
				label="after this PO"
			/>
		</div>
	);
}
