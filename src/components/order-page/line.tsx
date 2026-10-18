export function Line({
	label,
	value,
	strong = false,
	note,
}: {
	label: string;
	value: string;
	strong?: boolean;
	// Why the figure isn't final, under the label.
	note?: string;
}) {
	return (
		<div className="flex justify-between gap-3">
			<dt className={strong ? "font-semibold" : "text-muted-foreground"}>
				{label}
				{note && <div className="text-xs text-warning-text">{note}</div>}
			</dt>
			<dd className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>
				{value}
			</dd>
		</div>
	);
}

// One shipment: its boxes' labels, where this order's tracking stands, the
// other orders packed with it, a retry when tracking didn't reach the
// marketplace, and a two-step void of every box.
