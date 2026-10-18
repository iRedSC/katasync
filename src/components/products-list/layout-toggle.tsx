import { LayoutGrid, Rows3 } from "lucide-react";
import { cn } from "#/lib/utils";

// Cards for deciding, the table for comparing numbers side by side.
export function LayoutToggle({
	layout,
	onLayout,
}: {
	layout: "cards" | "table";
	onLayout: (layout: "cards" | "table") => void;
}) {
	return (
		<fieldset className="flex rounded-lg bg-surface-strong p-0.5">
			<legend className="sr-only">Layout</legend>
			{(
				[
					["cards", LayoutGrid, "Cards"],
					["table", Rows3, "Table"],
				] as const
			).map(([l, Icon, label]) => (
				<button
					key={l}
					type="button"
					aria-pressed={layout === l}
					onClick={() => onLayout(l)}
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium",
						layout === l
							? "bg-card text-foreground shadow-card"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<Icon className="size-3.5" />
					{label}
				</button>
			))}
		</fieldset>
	);
}
