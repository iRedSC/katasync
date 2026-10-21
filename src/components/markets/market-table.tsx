import { Link } from "@tanstack/react-router";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, Card } from "#/components/page";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { MarketDetail } from "#/markets/analytics";

// The markets side by side over the range: what each sells, keeps, and
// sends back, with how much waits to be acted on in each.

const pct = (n: number | null) =>
	n === null ? "—" : `${(n * 100).toFixed(1)}%`;

function Change({ now, before }: { now: number; before: number | undefined }) {
	if (!before) return null;
	const c = (now - before) / Math.abs(before);
	if (Math.abs(c) < 0.005) return null;
	return (
		<span
			className={cn(
				"ml-1.5 text-xs",
				c < 0 ? "text-critical-text" : "text-success-text",
			)}
		>
			{c > 0 ? "+" : ""}
			{(c * 100).toFixed(0)}%
		</span>
	);
}

export function MarketTable({ markets }: { markets: MarketDetail[] }) {
	const head = "px-4 py-2 font-medium";
	const num = "px-4 py-2 text-right";
	return (
		<Card title="Side by side" flush>
			<div className="overflow-x-auto">
				<table className="w-full tabular-nums">
					<thead className="text-left text-muted-foreground">
						<tr className="border-t">
							<th className={head}>Market</th>
							<th className={cn(head, "text-right")}>Sales</th>
							<th className={cn(head, "w-40")}>Share</th>
							<th className={cn(head, "text-right")}>Profit</th>
							<th className={cn(head, "text-right")}>Margin</th>
							<th className={cn(head, "text-right")}>Orders</th>
							<th className={cn(head, "text-right")}>Returns</th>
							<th className={head}>To act on</th>
						</tr>
					</thead>
					<tbody>
						{markets.map((m) => {
							const t = m.totals;
							const returns =
								m.returns.orders === 0
									? null
									: m.returns.ordersReturned / m.returns.orders;
							return (
								<tr key={m.market} className="border-t hover:bg-subtle">
									<td className="px-4 py-2">
										<Link
											to="/markets"
											search={(prev) => ({ ...prev, market: m.market })}
										>
											<ChannelBadge channel={m.market} salesChannel={null} />
										</Link>
									</td>
									<td className={num}>
										{formatMoney(t?.revenue ?? 0)}
										<Change
											now={t?.revenue ?? 0}
											before={m.previous?.revenue}
										/>
									</td>
									<td className="px-4 py-2">
										<div className="flex items-center gap-2">
											<div className="h-1.5 flex-1 rounded-full bg-surface-strong">
												<div
													className="h-full rounded-full bg-primary"
													style={{ width: `${m.share * 100}%` }}
												/>
											</div>
											<span className="w-12 text-right text-xs">
												{pct(m.share)}
											</span>
										</div>
									</td>
									<td
										className={cn(
											num,
											"font-semibold",
											(t?.profit ?? 0) < 0 && "text-critical-text",
										)}
									>
										{formatMoney(t?.profit ?? 0)}
									</td>
									<td className={num}>
										{pct(t && t.revenue > 0 ? t.profit / t.revenue : null)}
									</td>
									<td className={num}>{formatCount(t?.orders ?? 0)}</td>
									<td className={num}>{pct(returns)}</td>
									<td className="px-4 py-2">
										<Link
											to="/markets"
											search={(prev) => ({ ...prev, market: m.market })}
											className="flex flex-wrap gap-1"
										>
											{m.counts.toFix > 0 && (
												<Badge tone="critical">
													{formatCount(m.counts.toFix)}{" "}
													{m.counts.toFix === 1 ? "listing" : "listings"} to fix
												</Badge>
											)}
											{m.counts.unlisted > 0 && (
												<Badge>
													{formatCount(m.counts.unlisted)} not listed
												</Badge>
											)}
											{m.counts.losing > 0 && (
												<Badge tone="warning">
													{formatCount(m.counts.losing)} losing money
												</Badge>
											)}
										</Link>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</Card>
	);
}
