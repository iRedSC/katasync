import { Pencil } from "lucide-react";
import { formatCount } from "#/lib/format";
import { cn } from "#/lib/utils";

export function Tab({
	label,
	count,
	active,
	changed = false,
	onClick,
	onEdit,
}: {
	label: string;
	count: number;
	active: boolean;
	changed?: boolean;
	onClick: () => void;
	onEdit?: () => void;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-7 items-center rounded-lg font-medium",
				active
					? "bg-surface-strong text-foreground"
					: "text-muted-foreground hover:bg-surface hover:text-foreground",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				className="inline-flex h-full items-center gap-1.5 px-2.5"
			>
				{label}
				{changed ? (
					<span className="text-xs text-muted-foreground">edited</span>
				) : (
					<span className="tabular-nums text-muted-foreground">
						{formatCount(count)}
					</span>
				)}
			</button>
			{onEdit && (
				<button
					type="button"
					onClick={onEdit}
					aria-label={`Rename or delete ${label}`}
					className="-ml-1.5 mr-1 rounded p-1 text-muted-foreground hover:bg-line hover:text-foreground"
				>
					<Pencil className="size-3" />
				</button>
			)}
		</span>
	);
}
