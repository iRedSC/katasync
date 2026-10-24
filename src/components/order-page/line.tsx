import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";

// One figure and its label. A note says why the figure isn't final: the
// label gets a dotted underline that shows it on hover, and the figure is
// italic, so a number that may still change never looks settled.
export function Line({
	label,
	value,
	strong = false,
	note,
}: {
	label: string;
	value: string;
	strong?: boolean;
	note?: string;
}) {
	return (
		<div className="flex justify-between gap-3">
			<dt className={strong ? "font-semibold" : "text-muted-foreground"}>
				{note ? (
					<Tip content={note} side="left">
						<span
							// biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the note to keyboard users
							tabIndex={0}
							className="cursor-help underline decoration-current/40 decoration-dotted underline-offset-4"
						>
							{label}
						</span>
					</Tip>
				) : (
					label
				)}
			</dt>
			<dd
				className={cn(
					"tabular-nums",
					strong && "font-semibold",
					note && "italic",
				)}
			>
				{value}
			</dd>
		</div>
	);
}
