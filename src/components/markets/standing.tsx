import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { ChannelBadge } from "#/components/channel-badge";
import { Badge, Card, type Tone } from "#/components/page";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDateTime } from "#/lib/format";
import { cn } from "#/lib/utils";
import type { Market } from "#/markets/market";
import {
	type Level,
	type Metric,
	STANDING_PAGES,
	type Standing,
} from "#/markets/standing";
import type { getStanding } from "#/server/markets";

// Where each market's account stands: a tile per market on the overview,
// and the whole of it on the market's own tab. Color carries the level;
// words say only what color can't.

type Row = Awaited<ReturnType<typeof getStanding>>["rows"][number];

// What the page knows about one market's standing, all in one value, so
// no part of the page can show "good" while another shows "never checked".
export type StandingView =
	| { kind: "not_connected" }
	| { kind: "unchecked"; checking: boolean }
	| {
			kind: "known";
			standing: Standing;
			checkedAt: Date | null;
			// The latest check failed; `standing` is the one before it.
			error: string | null;
			checking: boolean;
	  };

export function standingView(
	market: Market,
	rows: Row[],
	checkable: Market[],
	checking: boolean,
): StandingView {
	if (!checkable.includes(market)) return { kind: "not_connected" };
	const row = rows.find((r) => r.market === market);
	if (!row?.standing)
		return row?.error
			? {
					kind: "known",
					standing: {
						level: null,
						verdict: { state: "waiting" },
						metrics: [],
						problems: [],
					},
					checkedAt: null,
					error: row.error,
					checking,
				}
			: { kind: "unchecked", checking };
	return {
		kind: "known",
		standing: row.standing,
		checkedAt: row.checkedAt,
		error: row.error,
		checking,
	};
}

const LEVEL: Record<Level, { tone: Tone; label: string; dot: string }> = {
	good: { tone: "success", label: "Good", dot: "bg-success-icon" },
	watch: { tone: "warning", label: "Watch", dot: "bg-warning-icon" },
	at_risk: { tone: "critical", label: "At risk", dot: "bg-critical-icon" },
};

// The level a view shows, or null when there's nothing to color it by.
export function levelOf(v: StandingView): Level | null {
	return v.kind === "known" ? v.standing.level : null;
}

export function LevelDot({ view }: { view: StandingView }) {
	const level = levelOf(view);
	return (
		<span
			className={cn(
				"size-2 shrink-0 rounded-full",
				level ? LEVEL[level].dot : "bg-surface-strong",
				view.kind !== "not_connected" && view.checking && "animate-pulse",
			)}
		/>
	);
}

function Verdict({ view }: { view: StandingView }) {
	if (view.kind === "not_connected") return <Badge>Not connected</Badge>;
	if (view.kind === "unchecked")
		return <Badge>{view.checking ? "Checking" : "Not checked"}</Badge>;
	const s = view.standing.verdict;
	if (s.state === "read") {
		// The badge is the whole standing: a good verdict with blocked
		// listings isn't good.
		const level = view.standing.level ?? s.level;
		return <Badge tone={LEVEL[level].tone}>{LEVEL[level].label}</Badge>;
	}
	if (s.state === "needs_access")
		return (
			<Tip content={s.fix}>
				<Badge tone="warning">Needs sign-in</Badge>
			</Tip>
		);
	return <Badge>{view.checking ? "Checking" : "Building"}</Badge>;
}

// When it was read, and whether the latest try failed.
function Freshness({ view }: { view: StandingView }) {
	if (view.kind !== "known") return null;
	return (
		<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
			{view.checkedAt && formatDateTime(view.checkedAt)}
			{view.error && (
				<Tip content={view.error}>
					<span className="font-medium text-critical-text">
						Last check failed
					</span>
				</Tip>
			)}
		</span>
	);
}

export function StandingTile({
	market,
	view,
}: {
	market: Market;
	view: StandingView;
}) {
	const s = view.kind === "known" ? view.standing : null;
	const problems = s?.problems ?? [];
	return (
		<Link
			to="/markets"
			search={(prev) => ({ ...prev, market })}
			className={cn(
				"flex flex-col gap-2 rounded-xl bg-card p-4 shadow-card hover:bg-subtle",
				levelOf(view) === "at_risk" && "ring-2 ring-critical-icon/40",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<ChannelBadge channel={market} salesChannel={null} />
				<Verdict view={view} />
			</div>
			{/* Counts only: what each one is waits in the queue below. */}
			<div className="flex items-baseline gap-4 tabular-nums">
				{(["at_risk", "watch"] as const).map((level) => {
					const n = problems.filter((p) => p.level === level).length;
					return n === 0 ? null : (
						<span
							key={level}
							className={cn(
								"text-xs font-medium",
								level === "at_risk"
									? "text-critical-text"
									: "text-warning-text",
							)}
						>
							<span className="mr-1 text-xl font-bold">{formatCount(n)}</span>
							{level === "at_risk" ? "at risk" : "to watch"}
						</span>
					);
				})}
				{view.kind === "known" && view.error && (
					<Tip content={view.error}>
						<span className="text-xs font-medium text-critical-text">
							Check failed
						</span>
					</Tip>
				)}
			</div>
		</Link>
	);
}

const pct = (n: number) => `${+(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;

function MetricRow({ m }: { m: Metric }) {
	const value =
		m.value.kind === "rate"
			? pct(m.value.rate)
			: m.value.kind === "count"
				? formatCount(m.value.count)
				: m.value.text;
	const of =
		m.value.kind === "rate" && m.value.count !== null && m.value.of !== null
			? `${formatCount(m.value.count)} of ${formatCount(m.value.of)}`
			: null;
	const target = m.target
		? `${m.target.kind === "below" ? "Under" : "Over"} ${pct(m.target.value)}`
		: null;
	return (
		<li className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 border-t px-4 py-2 first:border-t-0">
			<span className={cn("size-2 rounded-full", LEVEL[m.level].dot)} />
			<div className="min-w-0">
				<div className="font-medium">{m.label}</div>
				<div className="text-xs text-muted-foreground">
					{[of, m.window && `${m.window.from} to ${m.window.to}`]
						.filter(Boolean)
						.join(" · ")}
				</div>
			</div>
			<div className="text-right tabular-nums">
				<div
					className={cn(
						"font-semibold",
						m.level === "at_risk" && "text-critical-text",
						m.level === "watch" && "text-warning-text",
					)}
				>
					{value}
				</div>
				{target && (
					<div className="text-xs text-muted-foreground">{target}</div>
				)}
			</div>
		</li>
	);
}

// The verdict and metrics. Problems are in the attention queue below it.
export function StandingPanel({
	market,
	view,
}: {
	market: Market;
	view: StandingView;
}) {
	const s = view.kind === "known" ? view.standing : null;
	const verdict = s?.verdict;
	const level = levelOf(view);
	return (
		<Card
			flush
			title={
				<span className="flex items-center gap-2">
					Standing <Verdict view={view} />
				</span>
			}
			tone={
				level === "at_risk"
					? "critical"
					: level === "watch"
						? "warning"
						: undefined
			}
			aside={
				<a
					href={STANDING_PAGES[market]}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 hover:underline"
				>
					{verdict?.state === "read"
						? verdict.summary
						: "Open on the marketplace"}
					<ExternalLink className="size-3.5" />
				</a>
			}
		>
			{verdict?.state === "needs_access" && (
				<p className="border-t px-4 py-3 text-warning-text">{verdict.fix}</p>
			)}
			{s && s.metrics.length > 0 && (
				<ul className="border-t">
					{s.metrics.map((m) => (
						<MetricRow key={m.label} m={m} />
					))}
				</ul>
			)}
			<div className="border-t px-4 py-2">
				<Freshness view={view} />
			</div>
		</Card>
	);
}
