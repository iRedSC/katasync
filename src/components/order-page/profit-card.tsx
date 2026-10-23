import { Badge, Card } from "#/components/page";
import { channelName, formatCount, formatMoney } from "#/lib/format";
import type { OrderDetail } from "#/server/orders";
import { Line } from "./line";

const feesNote: Record<string, string | undefined> = {
	final: undefined,
	reported: "As reported so far; may still change",
	estimated: "Estimated until the marketplace reports it",
};
const labelsNote: Record<string, string | undefined> = {
	known: undefined,
	stand_in: "katasync's estimate until TikTok bills it",
	not_needed: undefined,
	not_shipped: "Not shipped yet",
	awaiting: "Waiting for the marketplace to report",
	missing: "Shipped, but no label cost from anyone. Bought somewhere else?",
};

// What the order made, and what each marketplace said it charged
// (src/orders/profit.ts). Anything not final says so.
export function ProfitCard({
	profit: p,
	charges,
	reports,
	checks,
}: Pick<OrderDetail, "charges" | "reports" | "checks"> & {
	profit: NonNullable<OrderDetail["profit"]>;
}) {
	const failed = checks.filter((c) => c.error);
	return (
		<Card
			title="Contribution"
			aside={
				p.complete ? undefined : (
					<Badge tone="warning">
						{p.awaitingReturn ? "Awaiting return" : "Waiting on a cost"}
					</Badge>
				)
			}
		>
			<dl className="flex flex-col gap-1">
				<Line label="Items" value={formatMoney(p.revenue)} />
				<Line label="Shipping charged" value={formatMoney(p.shippingCharged)} />
				<Line
					label="Cost of goods"
					value={formatMoney(-p.cost)}
					note={
						!p.costKnown
							? "A product has no cost"
							: p.awaitingReturn
								? "Refunded items not back yet aren't counted; they are if written off, or still out 60 days after the sale"
								: undefined
					}
				/>
				<Line
					label="Marketplace fees"
					value={formatMoney(-p.fees)}
					note={feesNote[p.feesStatus]}
				/>
				<Line
					label="Shipping labels"
					value={formatMoney(-p.labels)}
					note={labelsNote[p.labelsStatus]}
				/>
				{p.postageAdjustments !== 0 && (
					<Line
						label="Postage adjustments"
						value={formatMoney(-p.postageAdjustments)}
					/>
				)}
				{p.refunds !== 0 && (
					<Line label="Refunds" value={formatMoney(-p.refunds)} />
				)}
				{p.adjustments !== 0 && (
					<Line label="Adjustments" value={formatMoney(-p.adjustments)} />
				)}
				<div className="mt-1 border-t pt-1">
					<Line label="Contribution" value={formatMoney(p.profit)} strong />
				</div>
			</dl>
			{charges.length > 0 && (
				<details className="mt-3 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						{formatCount(charges.length)} charges reported
					</summary>
					<ul className="mt-1 flex flex-col gap-0.5">
						{charges.map((c, i) => (
							// Charges have no identity of their own on the page.
							// biome-ignore lint/suspicious/noArrayIndexKey: listed in order, never reordered
							<li key={i} className="flex justify-between gap-2">
								<span className="text-muted-foreground">
									{channelName(c.billedBy)}: {c.description}
								</span>
								<span className="tabular-nums">{formatMoney(-c.amount)}</span>
							</li>
						))}
					</ul>
				</details>
			)}
			{reports.length === 0 && checks.length === 0 && (
				<p className="mt-3 text-xs text-muted-foreground">
					Not asked about yet; the marketplace is asked within ten minutes.
				</p>
			)}
			{failed.map((c) => (
				<p key={c.billedBy} className="mt-3 text-xs text-critical-text">
					Asking {channelName(c.billedBy)} failed: {c.error}
				</p>
			))}
		</Card>
	);
}
