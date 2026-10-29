import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";

export type OrderTab = "ship" | "all" | "returns";

const tabs = [
	{ key: "ship", label: "To ship", to: "/orders", search: {} },
	{ key: "all", label: "All orders", to: "/orders", search: { view: "all" } },
	{
		key: "returns",
		label: "Returns & refunds",
		to: "/orders/returns",
		search: {},
	},
] as const;

// The tabs over every order list, Returns & refunds among them: an order
// with something coming back, or a refund waiting on our answer. The open one shows how many it lists; `aside`
// sits at the far end, for the tab's own views.
export function OrderTabs({
	active,
	count,
	aside,
}: {
	active: OrderTab;
	// Left out where the page isn't a list to count (Returns › Insights).
	count?: number;
	aside?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-1 border-b p-2">
			{tabs.map((t) => (
				<Link
					key={t.key}
					to={t.to}
					search={t.search}
					className={cn(
						"inline-flex h-7 items-center rounded-lg px-2.5 font-medium",
						active === t.key
							? "bg-surface-strong text-foreground"
							: "text-muted-foreground hover:bg-surface hover:text-foreground",
					)}
				>
					{t.label}
					{t.key === active && count !== undefined && (
						<span className="ml-1.5 text-muted-foreground tabular-nums">
							{formatCount(count)}
						</span>
					)}
				</Link>
			))}
			{aside && <div className="ml-auto flex items-center gap-1">{aside}</div>}
		</div>
	);
}

// Returns' two views, at the far end of its tab bar: what's open (refunds
// to answer, what's due back), and insights into why things come back.
export function ReturnsViews({
	active,
}: {
	active: "due" | "refunds" | "insights";
}) {
	const views = [
		{ key: "due", label: "Triage", to: "/orders/returns" },
		{ key: "refunds", label: "Refunds", to: "/orders/returns/refunds" },
		{ key: "insights", label: "Insights", to: "/orders/returns/insights" },
	] as const;
	return (
		<div className="flex rounded-lg bg-surface p-0.5">
			{views.map((v) => (
				<Link
					key={v.key}
					to={v.to}
					className={cn(
						"inline-flex h-6 items-center rounded-md px-2 text-xs font-medium",
						active === v.key
							? "bg-card text-foreground shadow-card"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{v.label}
				</Link>
			))}
		</div>
	);
}
