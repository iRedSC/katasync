import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "#/components/ui/tooltip";

// Ranked horizontal bars: one series, one hue, value at the tip. The whole row
// is the hover target so the tooltip is easy to hit.
export function BarList({
	rows,
	format,
	detail,
}: {
	rows: { label: string; value: number }[];
	format: (value: number) => string;
	detail?: (index: number) => string;
}) {
	const max = Math.max(...rows.map((r) => r.value), 1);
	return (
		<div className="flex flex-col gap-1">
			{rows.map((row, i) => (
				<Tooltip key={row.label}>
					<TooltipTrigger asChild>
						<div className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-4 rounded-lg px-2 py-1.5 hover:bg-[#f7f7f7]">
							<span className="truncate">{row.label}</span>
							<div className="flex items-center gap-3">
								<div
									className="h-2.5 rounded-r-[4px] bg-brand"
									style={{ width: `${(row.value / max) * 85}%` }}
								/>
								<span className="shrink-0 font-medium tabular-nums">
									{format(row.value)}
								</span>
							</div>
						</div>
					</TooltipTrigger>
					{detail && <TooltipContent side="top">{detail(i)}</TooltipContent>}
				</Tooltip>
			))}
		</div>
	);
}
