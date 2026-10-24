import { AlertTriangle } from "lucide-react";
import { Card } from "#/components/page";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import { ITEMS_LIMIT } from "#/orders/profit";
import { type Item, margin, percent } from "./item";

// Totals of what's shown, so a filter answers "how much did these make".
// When the range holds more items than load, these totals are only the
// newest ones, and the card says so rather than passing for the whole range.
export function Summary({ items, cut }: { items: Item[]; cut: boolean }) {
	const sum = (f: (i: Item) => number) =>
		items.reduce((total, i) => total + f(i), 0);
	const profit = sum((i) => i.profit);
	const revenue = sum((i) => i.revenue);
	const losses = items.filter((i) => i.profit < 0);
	const stats: [string, string, boolean?][] = [
		["Contribution", formatMoney(profit), profit < 0],
		["Margin", percent(margin({ profit, revenue }))],
		["Sales", formatMoney(revenue)],
		["Items sold", formatCount(sum((i) => i.quantity))],
		[
			"Lost money",
			`${formatCount(losses.length)} · ${formatMoney(sum((i) => Math.min(0, i.profit)))}`,
			losses.length > 0,
		],
	];
	return (
		<Card flush>
			<dl className="grid grid-cols-2 md:grid-cols-5 md:divide-x">
				{stats.map(([label, value, bad]) => (
					<div key={label} className="flex flex-col gap-1 p-4">
						<dt className="text-muted-foreground">{label}</dt>
						<dd
							className={cn(
								"text-xl font-bold tabular-nums",
								bad && "text-critical-text",
							)}
						>
							{value}
						</dd>
					</div>
				))}
			</dl>
			{cut && (
				<p className="flex items-center gap-2 border-t px-4 py-2 text-warning-text">
					<AlertTriangle className="size-4 shrink-0 text-warning-icon" />
					Totals of the newest {formatCount(ITEMS_LIMIT)} items only. A shorter
					range totals them all; the overview covers every order.
				</p>
			)}
		</Card>
	);
}
