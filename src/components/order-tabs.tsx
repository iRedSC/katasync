import { useNavigate } from "@tanstack/react-router";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";

export type OrderTab = "ship" | "all";

const tabs: { key: OrderTab; label: string }[] = [
	{ key: "ship", label: "To ship" },
	{ key: "all", label: "All orders" },
];

// The tabs over every order list. The open one shows how many it lists.
export function OrderTabs({
	active,
	count,
}: {
	active: OrderTab;
	count: number;
}) {
	const navigate = useNavigate();
	const go = (key: OrderTab) =>
		navigate({ to: "/orders", search: key === "ship" ? {} : { view: key } });
	return (
		<div className="flex gap-1 border-b p-2">
			{tabs.map((t) => (
				<button
					key={t.key}
					type="button"
					onClick={() => go(t.key)}
					className={cn(
						"inline-flex h-7 items-center rounded-lg px-2.5 font-medium",
						active === t.key
							? "bg-surface-strong text-foreground"
							: "text-muted-foreground hover:bg-surface hover:text-foreground",
					)}
				>
					{t.label}
					{t.key === active && (
						<span className="ml-1.5 text-muted-foreground tabular-nums">
							{formatCount(count)}
						</span>
					)}
				</button>
			))}
		</div>
	);
}
