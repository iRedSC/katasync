import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "#/lib/utils";
import { RANGES, type RangeKey } from "#/orders/profit";

// The two profit pages: every item sold, and the totals and rankings. Each
// opens on its own range; switching keeps the one picked.

export type ProfitView = "/profit" | "/profit/overview";

export const PROFIT_DEFAULTS: Record<ProfitView, RangeKey> = {
	"/profit": "today",
	"/profit/overview": "this_month",
};

const isRange = (v: unknown): v is RangeKey =>
	typeof v === "string" && Object.hasOwn(RANGES, v);

// The search a profit page keeps: its range, left out when it's the page's
// own default so the address stays short.
export function rangeSearch(view: ProfitView) {
	return (search: Record<string, unknown>): { range?: RangeKey } =>
		isRange(search.range) && search.range !== PROFIT_DEFAULTS[view]
			? { range: search.range }
			: {};
}

const searchFor = (view: ProfitView, range: RangeKey) =>
	range === PROFIT_DEFAULTS[view] ? {} : { range };

const tab = (active: boolean) =>
	cn(
		"inline-flex h-7 items-center rounded-lg px-2.5 font-medium",
		active
			? "bg-surface-strong text-foreground"
			: "text-muted-foreground hover:bg-surface hover:text-foreground",
	);

export function ProfitViews({
	view,
	range,
}: {
	view: ProfitView;
	range: RangeKey;
}) {
	const views: [ProfitView, string][] = [
		["/profit", "Items sold"],
		["/profit/overview", "Overview"],
	];
	return (
		<div className="flex gap-1 rounded-lg border p-0.5">
			{views.map(([to, label]) => (
				<Link
					key={to}
					to={to}
					search={searchFor(to, range)}
					className={tab(to === view)}
				>
					{label}
				</Link>
			))}
		</div>
	);
}

export function RangeTabs({
	view,
	range,
}: {
	view: ProfitView;
	range: RangeKey;
}) {
	const navigate = useNavigate();
	return (
		<div className="flex flex-wrap gap-1">
			{(Object.keys(RANGES) as RangeKey[]).map((key) => (
				<button
					key={key}
					type="button"
					onClick={() => navigate({ to: view, search: searchFor(view, key) })}
					className={tab(range === key)}
				>
					{RANGES[key]}
				</button>
			))}
		</div>
	);
}
