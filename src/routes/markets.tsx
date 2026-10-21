import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { RefreshCw, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelBadge } from "#/components/channel-badge";
import { AttentionQueue } from "#/components/markets/attention-queue";
import { MarketTable } from "#/components/markets/market-table";
import {
	BestSellers,
	Losing,
	Returned,
	Slipping,
	ToFix,
	Unlisted,
} from "#/components/markets/product-lists";
import {
	LevelDot,
	StandingPanel,
	StandingTile,
	type StandingView,
	standingView,
} from "#/components/markets/standing";
import { Card, EmptyState, Page } from "#/components/page";
import { FieldsCard, ListCard, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { MarketDetail } from "#/markets/analytics";
import { MARKETS, type Market, STALE_MS } from "#/markets/market";
import type { QueueEntry } from "#/markets/queue";
import { RANGES, type RangeKey } from "#/orders/profit";
import { getMarkets, getStanding, refreshStanding } from "#/server/markets";

// Every marketplace in one place: where each account stands, what sells
// where, and what to do about it. The overview compares them; each market's
// tab lists the products to act on there.

const DEFAULT_RANGE: RangeKey = "last_30_days";

type Search = { market?: Market; range?: RangeKey };

export const Route = createFileRoute("/markets")({
	validateSearch: (search: Record<string, unknown>): Search => ({
		...(MARKETS.includes(search.market as Market)
			? { market: search.market as Market }
			: {}),
		...(typeof search.range === "string" &&
		Object.hasOwn(RANGES, search.range) &&
		search.range !== DEFAULT_RANGE
			? { range: search.range as RangeKey }
			: {}),
	}),
	loaderDeps: ({ search }) => ({ range: search.range ?? DEFAULT_RANGE }),
	loader: async ({ deps }) => {
		const [markets, standing] = await Promise.all([
			getMarkets({ data: { range: deps.range } }),
			getStanding(),
		]);
		return { ...markets, standing };
	},
	component: Markets,
	pendingComponent: () => (
		<ListSkeleton title="Markets">
			<FieldsCard lines={2} />
			<ListCard rows={4} />
			<div className="grid gap-4 lg:grid-cols-2">
				<ListCard rows={6} picture />
				<ListCard rows={6} picture />
			</div>
		</ListSkeleton>
	),
});

const tab = (active: boolean) =>
	cn(
		"inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 font-medium",
		active
			? "bg-surface-strong text-foreground"
			: "text-muted-foreground hover:bg-surface hover:text-foreground",
	);

// Reads standing again when what's kept is stale, once per visit; and on
// demand, all of it. The tiles pulse while it runs.
function useStandingCheck(stale: boolean) {
	const router = useRouter();
	const [checking, setChecking] = useState(false);
	const check = async (maxAgeMs?: number) => {
		setChecking(true);
		try {
			await refreshStanding({
				data: maxAgeMs === undefined ? {} : { maxAgeMs },
			});
			await router.invalidate();
		} catch (error) {
			toast.error("Couldn't check standing", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setChecking(false);
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per visit
	useEffect(() => {
		if (stale) void check();
	}, []);
	return { checking, checkAll: () => check(0) };
}

function Markets() {
	const d = Route.useLoaderData();
	const { market, range = DEFAULT_RANGE } = Route.useSearch();
	const navigate = useNavigate({ from: "/markets" });
	const { rows, checkable } = d.standing;
	const stale = checkable.some((m) => {
		const r = rows.find((row) => row.market === m);
		const tried = Math.max(
			r?.checkedAt ? new Date(r.checkedAt).getTime() : 0,
			r?.erroredAt ? new Date(r.erroredAt).getTime() : 0,
		);
		return Date.now() - tried >= STALE_MS;
	});
	const { checking, checkAll } = useStandingCheck(stale);
	const view = (m: Market): StandingView =>
		standingView(m, rows, checkable, checking);
	const detail = market ? d.markets.find((m) => m.market === market) : null;

	return (
		<Page
			title="Markets"
			width="wide"
			actions={
				<Tip content="Check standing now">
					<Button
						variant="ghost"
						size="sm"
						onClick={checkAll}
						disabled={checking}
						aria-label="Check standing now"
					>
						<RefreshCw className={cn(checking && "animate-spin")} />
					</Button>
				</Tip>
			}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap gap-1 rounded-lg border p-0.5">
					<Link
						to="/markets"
						search={(prev) => ({ ...prev, market: undefined })}
						className={tab(!market)}
					>
						All
					</Link>
					{d.markets.map((m) => (
						<Link
							key={m.market}
							to="/markets"
							search={(prev) => ({ ...prev, market: m.market })}
							className={tab(market === m.market)}
						>
							<LevelDot view={view(m.market)} />
							<ChannelBadge channel={m.market} salesChannel={null} compact />
						</Link>
					))}
				</div>
				<div className="flex flex-wrap gap-1">
					{(Object.keys(RANGES) as RangeKey[]).map((key) => (
						<button
							key={key}
							type="button"
							onClick={() =>
								navigate({
									search: (prev) => ({
										...prev,
										range: key === DEFAULT_RANGE ? undefined : key,
									}),
								})
							}
							className={tab(range === key)}
						>
							{RANGES[key]}
						</button>
					))}
				</div>
			</div>

			{d.markets.length === 0 ? (
				<EmptyState icon={Store} title="No marketplaces connected" />
			) : detail ? (
				<MarketTab
					m={detail}
					all={d.markets}
					view={view(detail.market)}
					queue={d.standing.queue.filter((e) => e.market === detail.market)}
				/>
			) : (
				<>
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						{d.markets.map((m) => (
							<StandingTile
								key={m.market}
								market={m.market}
								view={view(m.market)}
							/>
						))}
					</div>
					<AttentionQueue entries={d.standing.queue} showMarket />
					<MarketTable markets={d.markets} />
				</>
			)}
		</Page>
	);
}

const rate = (r: { orders: number; ordersReturned: number }) =>
	r.orders === 0 ? null : r.ordersReturned / r.orders;
const pct = (n: number | null) =>
	n === null ? "—" : `${(n * 100).toFixed(1)}%`;

function Stat({
	label,
	value,
	note,
	tone,
}: {
	label: string;
	value: string;
	note?: string | null;
	tone?: "critical" | "success";
}) {
	return (
		<div className="flex flex-col gap-1 p-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-xl font-bold tabular-nums">{value}</dd>
			{note && (
				<dd
					className={cn(
						"text-xs tabular-nums",
						tone === "critical"
							? "text-critical-text"
							: tone === "success"
								? "text-success-text"
								: "text-muted-foreground",
					)}
				>
					{note}
				</dd>
			)}
		</div>
	);
}

function change(now: number, before: number | undefined) {
	if (!before) return null;
	const c = (now - before) / Math.abs(before);
	return Math.abs(c) < 0.005 ? null : c;
}
const changeNote = (c: number | null) =>
	c === null
		? null
		: `${c > 0 ? "+" : ""}${(c * 100).toFixed(0)}% on the period before`;

function MarketTab({
	m,
	all,
	view,
	queue,
}: {
	m: MarketDetail;
	all: MarketDetail[];
	view: StandingView;
	queue: QueueEntry[];
}) {
	const t = m.totals;
	const sales = change(t?.revenue ?? 0, m.previous?.revenue);
	const profit = change(t?.profit ?? 0, m.previous?.profit);
	const everywhere = rate(
		all.reduce(
			(s, x) => ({
				orders: s.orders + x.returns.orders,
				ordersReturned: s.ordersReturned + x.returns.ordersReturned,
			}),
			{ orders: 0, ordersReturned: 0 },
		),
	);
	const here = rate(m.returns);
	return (
		<>
			<StandingPanel market={m.market} view={view} />
			<AttentionQueue entries={queue} showMarket={false} />
			<Card flush>
				<dl className="grid grid-cols-2 md:grid-cols-5 md:divide-x">
					<Stat
						label="Sales"
						value={formatMoney(t?.revenue ?? 0)}
						note={changeNote(sales)}
						tone={
							sales === null ? undefined : sales < 0 ? "critical" : "success"
						}
					/>
					<Stat
						label="Profit"
						value={formatMoney(t?.profit ?? 0)}
						note={changeNote(profit)}
						tone={
							profit === null ? undefined : profit < 0 ? "critical" : "success"
						}
					/>
					<Stat
						label="Margin"
						value={pct(t && t.revenue > 0 ? t.profit / t.revenue : null)}
					/>
					<Stat
						label="Share of sales"
						value={pct(m.share)}
						note={t ? `${formatCount(t.orders)} orders` : null}
					/>
					<Stat
						label="Returns"
						value={pct(here)}
						note={
							everywhere === null ? null : `${pct(everywhere)} on all markets`
						}
						tone={
							here !== null && everywhere !== null && here > everywhere * 1.25
								? "critical"
								: undefined
						}
					/>
				</dl>
			</Card>
			<div className="grid items-start gap-4 lg:grid-cols-2">
				<div className="flex flex-col gap-4">
					<ToFix rows={m.toFix} count={m.counts.toFix} />
					{m.best.length > 0 ? (
						<BestSellers rows={m.best} />
					) : (
						<Card title="Best sellers here">
							<p className="text-muted-foreground">
								Nothing sold here in this range.
							</p>
						</Card>
					)}
					<Slipping rows={m.slipping} />
				</div>
				<div className="flex flex-col gap-4">
					<Unlisted rows={m.unlisted} />
					<Losing rows={m.losing} />
					<Returned rows={m.returned} />
				</div>
			</div>
		</>
	);
}
