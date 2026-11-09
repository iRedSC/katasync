import { Fragment } from "react";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import type { Sales } from "#/purchasing/reorder/profit";

// On hand, with what's on sent POs and not here yet after it.
export function StockCell({
	onHand,
	onOrder,
}: {
	onHand: number;
	onOrder: number;
}) {
	return (
		<>
			{formatCount(onHand)}
			{onOrder > 0 && (
				<Tip content="On sent POs, not here yet">
					<span className="ml-1 text-xs text-muted-foreground">
						+{formatCount(onOrder)}
					</span>
				</Tip>
			)}
		</>
	);
}

// Units sold over 30 days; hovering shows a week to a year.
export function SalesCell({ sales }: { sales: Sales | null }) {
	if (!sales) return <span className="text-muted-foreground">—</span>;
	const rows: [string, number][] = [
		["7 days", sales.d7],
		["30 days", sales.d30],
		["3 months", sales.d90],
		["6 months", sales.d180],
		["1 year", sales.d365],
	];
	return (
		<Tip
			content={
				<dl className="grid grid-cols-[auto_auto] gap-x-4 tabular-nums">
					{rows.map(([label, n]) => (
						<Fragment key={label}>
							<dt>{label}</dt>
							<dd className="text-right">{formatCount(n)}</dd>
						</Fragment>
					))}
				</dl>
			}
		>
			<span className={sales.d30 === 0 ? "text-muted-foreground" : undefined}>
				{formatCount(sales.d30)}
			</span>
		</Tip>
	);
}
