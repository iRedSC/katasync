import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, Card, EmptyState, Page } from "#/components/page";
import { day, ordersCount, ReturnRow } from "#/components/return-row";
import { ReturnsTabs } from "#/components/returns-tabs";
import { FieldsCard, ListCard, ListSkeleton } from "#/components/skeleton";
import { Tip } from "#/components/ui/tooltip";
import { channelName, formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";
import { RECENT_DAYS, type RecentReturn } from "#/orders/recent-returns";
import type { ReturnedLine, ReturnRate } from "#/orders/return-rates";
import { returnReasons } from "#/orders/return-reasons";
import { getReturnInsights } from "#/server/returns";

// What comes back, how often, and why: products returned more than their
// sales explain, set apart from ones that come back a lot only because they
// sell a lot. Rules live in drizzle/0064 and 0065.

export const Route = createFileRoute("/orders/returns_/insights")({
	loader: () => getReturnInsights(),
	component: Insights,
	pendingComponent: () => (
		<ListSkeleton title="Returns">
			<FieldsCard lines={2} />
			<ListCard rows={6} picture />
		</ListSkeleton>
	),
});

const percent = (rate: number) =>
	`${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;

// Fewer orders than this and one more could change the picture.
const FEW_ORDERS = 5;

function Insights() {
	const data = Route.useLoaderData();
	const linesOf = (productId: number) =>
		data.lines.filter((l) => l.productId === productId);
	const sold = data.channels.reduce((n, c) => n + c.orders, 0);
	const [showAll, setShowAll] = useState(false);
	const [showOnce, setShowOnce] = useState(false);
	const [showRecent, setShowRecent] = useState(false);
	const recent = showRecent ? data.recent : data.recent.slice(0, 10);
	const expected = showAll ? data.expected : data.expected.slice(0, 10);
	const reasonMax = Math.max(1, ...data.reasons.map((r) => r.lines));
	// Channels whose returns say why; the others' refunds don't.
	const reasonChannels = data.channels
		.filter((c) => c.evidence.includes("reasons"))
		.map((c) => channelName(c.channel))
		.join(", ");

	return (
		<Page title="Returns">
			<Card flush>
				<ReturnsTabs active="insights" />
				<div className="flex flex-col gap-3 p-4">
					<p className="text-muted-foreground">
						Orders placed {day(data.window.from)} to {day(data.window.until)}.
						The last 45 days are left out so their returns have had time to come
						in. Something counts as returned when it was received here, a buyer
						asked to return it, or the order was refunded in full (kept or not).
						Rates count orders, not units: a buyer sending back 3 from one order
						is one return.
					</p>
					{sold === 0 ? null : (
						<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
							{data.channels.map((c) => (
								<div key={c.channel} className="rounded-lg border p-3">
									<div className="flex items-center justify-between gap-2">
										<ChannelBadge channel={c.channel} salesChannel={null} />
										<span className="font-semibold tabular-nums">
											{percent(c.ordersReturned / c.orders)}
										</span>
									</div>
									<p className="mt-1 tabular-nums">
										{formatCount(c.ordersReturned)} of {formatCount(c.orders)}{" "}
										orders sent something back
									</p>
									<p className="text-xs text-muted-foreground">{c.evidence}</p>
								</div>
							))}
						</div>
					)}
				</div>
			</Card>

			{sold === 0 ? (
				<Card>
					<EmptyState icon={ShieldCheck} title="No sales old enough yet">
						Return rates start once orders are more than 45 days old.
					</EmptyState>
				</Card>
			) : (
				<>
					<Card
						title="Returned more than their sales explain"
						aside={`${formatCount(data.flagged.length)} products`}
						flush
					>
						{data.flagged.length === 0 ? (
							<EmptyState icon={ShieldCheck} title="Nothing stands out">
								Every product comes back about as often as the channels it sells
								on would predict.
							</EmptyState>
						) : (
							<p className="px-4 pb-2 text-muted-foreground">
								Each is held to the usual rate of the channels it sold on, and
								ranked by how many returns that doesn't explain.
							</p>
						)}
						{data.flagged.map((r) => (
							<RateRow
								key={r.productId}
								rate={r}
								lines={linesOf(r.productId)}
							/>
						))}
						{data.once.length > 0 && (
							<>
								<button
									type="button"
									onClick={() => setShowOnce(!showOnce)}
									aria-expanded={showOnce}
									className="flex w-full items-center gap-3 border-t px-4 py-2.5 text-left text-muted-foreground hover:bg-surface"
								>
									<ChevronRight
										className={cn(
											"size-4 shrink-0 transition-transform",
											showOnce && "rotate-90",
										)}
									/>
									{formatCount(data.once.length)} more came back once. One
									return isn't a pattern yet.
								</button>
								{showOnce &&
									data.once.map((r) => (
										<RateRow
											key={r.productId}
											rate={r}
											lines={linesOf(r.productId)}
										/>
									))}
							</>
						)}
					</Card>

					{data.recent.length > 0 && (
						<Card
							title="Came back lately"
							aside={`orders from the last ${RECENT_DAYS} days`}
							flush
						>
							<p className="px-4 pb-2 text-muted-foreground">
								Too soon for a rate: these orders may still come back. Watch for
								the same reason twice.
							</p>
							{recent.map((p) => (
								<RecentRow key={p.productId} product={p} />
							))}
							{data.recent.length > 10 && (
								<button
									type="button"
									onClick={() => setShowRecent(!showRecent)}
									className="w-full border-t px-4 py-2.5 text-link hover:bg-surface"
								>
									{showRecent
										? "Show fewer"
										: `Show all ${formatCount(data.recent.length)}`}
								</button>
							)}
						</Card>
					)}

					{data.reasons.length > 0 && (
						<Card
							title="Why buyers send things back"
							aside={`${reasonChannels} · returned orders`}
						>
							<div className="flex flex-col gap-1.5">
								{data.reasons.map((r) => (
									<div key={r.chip} className="flex items-center gap-3">
										<span className="w-44 shrink-0 truncate">{r.text}</span>
										<div className="h-2 flex-1 rounded-full bg-surface">
											<div
												className="h-2 rounded-full bg-info-fill"
												style={{ width: `${(r.lines / reasonMax) * 100}%` }}
											/>
										</div>
										<span className="w-8 text-right tabular-nums">
											{formatCount(r.lines)}
										</span>
									</div>
								))}
							</div>
						</Card>
					)}

					{data.expected.length > 0 && (
						<Card
							title="Come back about as often as they sell"
							aside={`${formatCount(data.expected.length)} products`}
							flush
						>
							<p className="px-4 pb-2 text-muted-foreground">
								These had returns, but no more than their sales predict.
							</p>
							{expected.map((r) => (
								<RateRow
									key={r.productId}
									rate={r}
									lines={linesOf(r.productId)}
								/>
							))}
							{data.expected.length > 10 && (
								<button
									type="button"
									onClick={() => setShowAll(!showAll)}
									className="w-full border-t px-4 py-2.5 text-link hover:bg-surface"
								>
									{showAll
										? "Show fewer"
										: `Show all ${formatCount(data.expected.length)}`}
								</button>
							)}
						</Card>
					)}
				</>
			)}
		</Page>
	);
}

// One product: how many came back against what its sales predict.
function RateRow({
	rate: r,
	lines,
}: {
	rate: ReturnRate;
	lines: ReturnedLine[];
}) {
	const flagged = r.rateLow > r.baseline && r.ordersReturned > 1;
	return (
		<ReturnRow
			product={r}
			lines={lines}
			summary={
				<>
					<div>
						{formatCount(r.ordersReturned)} of {ordersCount(r.orders)} came back
						· {percent(r.rate)}
					</div>
					<div className="text-xs text-muted-foreground">
						{formatCount(r.returned)} of {formatCount(r.sold)} units ·{" "}
						{r.expected < 0.1
							? "almost none expected"
							: `about ${r.expected.toFixed(1)} expected`}
					</div>
				</>
			}
			badge={
				flagged && r.orders < FEW_ORDERS ? (
					<Tip
						content={`Only ${ordersCount(r.orders)}, so one more could change this a lot`}
					>
						<span>
							<Badge>Few orders</Badge>
						</span>
					</Tip>
				) : flagged ? (
					<Badge tone="critical">{r.excess.toFixed(1)} too many</Badge>
				) : null
			}
		/>
	);
}

// One product's orders from the last 90 days that came back. Too soon for a
// rate, so it says how many and flags the same reason twice.
function RecentRow({ product: p }: { product: RecentReturn }) {
	const repeated = repeatedReason(p.lines);
	return (
		<ReturnRow
			product={p}
			lines={p.lines}
			summary={
				<>
					<div>
						{formatCount(p.ordersReturned)} of {ordersCount(p.orders)} came back
					</div>
					<div className="text-xs text-muted-foreground">
						latest order {day(new Date(p.lines[0].placedAt))}
					</div>
				</>
			}
			badge={
				repeated ? (
					<Tip content={`${repeated.orders} orders said ${repeated.text}`}>
						<span>
							<Badge tone="warning">Repeat reason</Badge>
						</span>
					</Tip>
				) : null
			}
		/>
	);
}

// A reason more than one order gave, the most given first.
function repeatedReason(lines: ReturnedLine[]) {
	const counts = new Map<string, { text: string; orders: Set<number> }>();
	for (const l of lines)
		for (const r of returnReasons(l.reasons.join("; "))) {
			const seen = counts.get(r.chip) ?? { text: r.text, orders: new Set() };
			seen.orders.add(l.orderId);
			counts.set(r.chip, seen);
		}
	const top = [...counts.values()].sort(
		(a, b) => b.orders.size - a.orders.size,
	)[0];
	return top && top.orders.size > 1
		? { text: top.text.toLowerCase(), orders: top.orders.size }
		: null;
}
