import { useEffect, useRef } from "react";

// A table's tick column. The box's whole cell ticks, so a near miss doesn't
// open the row instead. `range` is a shift-click. A click on the box itself,
// or Space on it, lands here too.
export function TickCell({
	as: Cell,
	label,
	checked,
	mixed = false,
	onTick,
}: {
	as: "td" | "th";
	label: string;
	checked: boolean;
	mixed?: boolean;
	onTick: (range: boolean) => void;
}) {
	return (
		<Cell
			onClick={(e) => {
				e.stopPropagation();
				onTick(e.shiftKey);
			}}
			onAuxClick={(e) => e.stopPropagation()}
			// Enter on the box mustn't also open the row.
			onKeyDown={(e) => e.stopPropagation()}
			className="w-10 cursor-pointer py-2 pr-1 pl-4 select-none"
		>
			<TickBox label={label} checked={checked} mixed={mixed} />
		</Cell>
	);
}

function TickBox({
	label,
	checked,
	mixed,
}: {
	label: string;
	checked: boolean;
	mixed: boolean;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = mixed;
	}, [mixed]);
	return (
		<input
			ref={ref}
			type="checkbox"
			aria-label={label}
			checked={checked}
			// The cell around it does the ticking.
			onChange={() => {}}
			className="size-4 cursor-pointer accent-primary align-middle"
		/>
	);
}
