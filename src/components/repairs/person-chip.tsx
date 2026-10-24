import { cn } from "#/lib/utils";

// Who has a repair, as a chip whose color stays with the person (by when
// they were added, so the first few never share one), so each technician's
// cards are told apart at a glance across the board.

const colors = [
	"bg-info-fill text-info-text",
	"bg-success-fill text-success-text",
	"bg-warning-fill text-warning-text",
	"bg-abc-a-fill text-abc-a-text",
	"bg-abc-b-fill text-abc-b-text",
	"bg-abc-c-fill text-abc-c-text",
];

export const colorOf = (personId: number) => colors[personId % colors.length];

export function PersonChip({
	id,
	name,
	active = true,
	className,
}: {
	id: number;
	name: string;
	active?: boolean;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap",
				active ? colorOf(id) : "bg-surface-strong text-muted-foreground",
				className,
			)}
		>
			{name}
		</span>
	);
}
