import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "#/lib/utils";
import { RANGES, type RangeKey } from "#/orders/profit";

// The profit pages: every item sold, the totals and rankings, and what
// carriers re-billed with what to fix. Each opens on its own range; switching
// keeps the one picked.

export type ProfitView = "/profit" | "/analytics" | "/profit/postage";

export const PROFIT_DEFAULTS: Record<ProfitView, RangeKey> = {
	"/profit": "today",
	"/analytics": "this_month",
	// Re-bills post weeks after the sale, so a short range shows few.
	"/profit/postage": "last_90_days",
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

// Null is days picked on the items list, which the other views can't show,
// so they open on their own.
// The items list keeps it as `period`, since it can also be picked days.
export const searchFor = (view: ProfitView, range: RangeKey | null) =>
	range === null || range === PROFIT_DEFAULTS[view]
		? {}
		: view === "/profit"
			? { period: range }
			: { range };

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
	range: RangeKey | null;
}) {
	const views: [ProfitView, string][] = [
		["/profit", "Items sold"],
		["/analytics", "Overview"],
		["/profit/postage", "Fix postage"],
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
