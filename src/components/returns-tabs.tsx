import { Link } from "@tanstack/react-router";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";

export type ReturnsTab = "due" | "insights";

const tabs = [
	{ key: "due", label: "Due back", to: "/orders/returns" },
	{ key: "insights", label: "Insights", to: "/orders/returns/insights" },
] as const;

// The tabs over the Returns pages. Due back shows how many orders it lists.
export function ReturnsTabs({
	active,
	due,
}: {
	active: ReturnsTab;
	due?: number;
}) {
	return (
		<div className="flex gap-1 border-b p-2">
			{tabs.map((t) => (
				<Link
					key={t.key}
					to={t.to}
					className={cn(
						"inline-flex h-7 items-center rounded-lg px-2.5 font-medium",
						active === t.key
							? "bg-surface-strong text-foreground"
							: "text-muted-foreground hover:bg-surface hover:text-foreground",
					)}
				>
					{t.label}
					{t.key === "due" && due !== undefined && (
						<span className="ml-1.5 text-muted-foreground tabular-nums">
							{formatCount(due)}
						</span>
					)}
				</Link>
			))}
		</div>
	);
}
