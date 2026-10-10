import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "#/lib/utils";

// How far one drag can move a number, and how many pixels make one step.
const REACH = 10;
const STEP_PX = 14;
// Movement before a press counts as a drag rather than a click into the field.
const SLOP_PX = 5;

// Drag sideways on an element to change a whole number by up to REACH either
// way; let go and drag again to go further. Never below 0. A plain click is
// left alone, so the element can still be typed into.
//
// Spread `handlers` onto the element and render `line` anywhere; it floats
// under the element, outside any card that would clip it.
export function useNumberLine({
	value,
	onCommit,
	disabled,
}: {
	value: number;
	onCommit: (next: number) => void;
	disabled?: boolean;
}) {
	const drag = useRef<{
		x: number;
		start: number;
		active: boolean;
		// Where the line hangs: under the middle of the element.
		anchor: { x: number; y: number };
	} | null>(null);
	const [preview, setPreview] = useState<{
		start: number;
		value: number;
		anchor: { x: number; y: number };
	} | null>(null);

	const valueAt = (start: number, dx: number) =>
		Math.min(
			Math.max(start + Math.round(dx / STEP_PX), Math.max(0, start - REACH)),
			start + REACH,
		);

	const handlers = {
		onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
			if (disabled || e.button > 0) return;
			const r = e.currentTarget.getBoundingClientRect();
			drag.current = {
				x: e.clientX,
				start: value,
				active: false,
				anchor: { x: r.left + r.width / 2, y: r.bottom },
			};
		},
		onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
			const d = drag.current;
			if (!d) return;
			const dx = e.clientX - d.x;
			if (!d.active) {
				if (Math.abs(dx) < SLOP_PX) return;
				d.active = true;
				// Keep getting moves if the pointer leaves the field. It can be gone
				// already (a lifted finger), and the drag still works without it.
				try {
					e.currentTarget.setPointerCapture(e.pointerId);
				} catch {}
				// A drag isn't typing: drop the caret and any selection.
				e.currentTarget.blur();
				window.getSelection()?.removeAllRanges();
			}
			e.preventDefault();
			setPreview({
				start: d.start,
				value: valueAt(d.start, dx),
				anchor: d.anchor,
			});
		},
		onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
			const d = drag.current;
			drag.current = null;
			if (!d?.active) return;
			const next = valueAt(d.start, e.clientX - d.x);
			setPreview(null);
			if (next !== d.start) onCommit(next);
		},
		onPointerCancel: () => {
			drag.current = null;
			setPreview(null);
		},
	};

	return {
		handlers,
		dragging: preview !== null,
		// The number to show while dragging, else the real one.
		shown: preview?.value ?? value,
		line: preview && createPortal(<NumberLine {...preview} />, document.body),
	};
}

// The ruler under the field while dragging: ticks from start - REACH to
// start + REACH, the start under the field, the current value marked. 0 is a
// trash can, since landing there takes the line off.
function NumberLine({
	start,
	value,
	anchor,
}: {
	start: number;
	value: number;
	anchor: { x: number; y: number };
}) {
	const lo = Math.max(0, start - REACH);
	const hi = start + REACH;
	const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
	return (
		<div
			className="pointer-events-none fixed z-50 h-11 rounded-xl bg-white shadow-card"
			style={{
				top: anchor.y + 8,
				// Keep the start tick under the middle of the field.
				left: anchor.x - ((start - lo) * STEP_PX + 16),
				width: (hi - lo) * STEP_PX + 32,
			}}
		>
			{ticks.map((n) => {
				const left = (n - lo) * STEP_PX + 16;
				const current = n === value;
				const major = n === start || n % 5 === 0;
				return (
					<div
						key={n}
						className="absolute top-2 flex -translate-x-1/2 flex-col items-center"
						style={{ left }}
					>
						<div
							className={cn(
								"w-px",
								major ? "h-3 bg-[#8a8a8a]" : "h-2 bg-[#cccccc]",
								current && "h-3 w-0.5 bg-foreground",
							)}
						/>
						{n === 0 ? (
							<Trash2
								className={cn(
									"mt-1 size-3.5",
									current ? "text-critical-text" : "text-[#8a8a8a]",
								)}
							/>
						) : (
							(major || current) && (
								<span
									className={cn(
										"mt-1 text-[0.6875rem] leading-none tabular-nums",
										current
											? "font-bold text-foreground"
											: "text-muted-foreground",
									)}
								>
									{n}
								</span>
							)
						)}
					</div>
				);
			})}
		</div>
	);
}
