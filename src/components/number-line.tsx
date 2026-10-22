import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "#/lib/utils";

// How far one drag can move a number, and how many pixels make one step.
const REACH = 5;
const STEP_PX = 28;
// Movement before a press counts as a drag rather than a click into the field.
const SLOP_PX = 5;
// Past the end of the line the number keeps going on its own: this many steps
// a second, plus one more for every few pixels further out.
const SCRUB_BASE_RATE = 6;
const SCRUB_PX_PER_RATE = 6;

type Anchor = { x: number; y: number };

// Drag sideways on an element to change a whole number by up to REACH either
// way. Hold past either end and it scrubs: the line slides and the number
// keeps moving, faster the further out. Never below 0. A plain click is left
// alone, so the element can still be typed into.
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
		dx: number;
		start: number;
		// How far scrubbing has slid the line, in steps (fractional while moving).
		shift: number;
		active: boolean;
		// Where the line hangs: under the middle of the element.
		anchor: Anchor;
		frame: number | null;
		lastTime: number;
	} | null>(null);
	// Whether the last press was a drag, so its release isn't also a click.
	const dragged = useRef(false);
	const [preview, setPreview] = useState<{
		start: number;
		value: number;
		anchor: Anchor;
	} | null>(null);

	// The line's center after scrubbing, and the value under the pointer on it.
	const read = (d: NonNullable<typeof drag.current>) => {
		const center = Math.max(0, d.start + Math.round(d.shift));
		const lo = Math.max(0, center - REACH);
		const hi = center + REACH;
		const raw = center + Math.round(d.dx / STEP_PX);
		return { center, value: Math.min(Math.max(raw, lo), hi), raw, lo, hi };
	};

	const show = (d: NonNullable<typeof drag.current>) => {
		const r = read(d);
		setPreview({ start: r.center, value: r.value, anchor: d.anchor });
	};

	// How far past an end the pointer is, signed, or 0 when on the line. Below
	// the low end only counts while the line can still go lower.
	const overshoot = (d: NonNullable<typeof drag.current>) => {
		const px = Math.abs(d.dx) - REACH * STEP_PX;
		if (px <= 0) return 0;
		if (d.dx < 0 && read(d).lo === 0) return 0;
		return Math.sign(d.dx) * px;
	};

	const tick = (time: number) => {
		const d = drag.current;
		if (!d) return;
		const over = overshoot(d);
		if (over === 0) {
			d.frame = null;
			return;
		}
		const seconds = Math.min((time - d.lastTime) / 1000, 0.1);
		const rate = SCRUB_BASE_RATE + Math.abs(over) / SCRUB_PX_PER_RATE;
		d.shift += Math.sign(over) * rate * seconds;
		d.lastTime = time;
		show(d);
		d.frame = requestAnimationFrame(tick);
	};

	const stop = () => {
		const d = drag.current;
		if (d?.frame != null) cancelAnimationFrame(d.frame);
		drag.current = null;
		setPreview(null);
	};
	// Unmounting mid-drag (a removed row, say) may never see the pointer end,
	// so the scrub stops here, without a commit.
	useEffect(
		() => () => {
			const d = drag.current;
			if (d?.frame != null) cancelAnimationFrame(d.frame);
			drag.current = null;
		},
		[],
	);

	const handlers = {
		onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
			if (disabled || e.button > 0) return;
			dragged.current = false;
			const r = e.currentTarget.getBoundingClientRect();
			drag.current = {
				x: e.clientX,
				dx: 0,
				start: value,
				shift: 0,
				active: false,
				anchor: { x: r.left + r.width / 2, y: r.bottom },
				frame: null,
				lastTime: 0,
			};
		},
		onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
			const d = drag.current;
			if (!d) return;
			d.dx = e.clientX - d.x;
			if (!d.active) {
				if (Math.abs(d.dx) < SLOP_PX) return;
				d.active = true;
				dragged.current = true;
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
			show(d);
			if (overshoot(d) !== 0 && d.frame === null) {
				d.lastTime = performance.now();
				d.frame = requestAnimationFrame(tick);
			}
		},
		onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
			const d = drag.current;
			if (!d?.active) {
				stop();
				return;
			}
			d.dx = e.clientX - d.x;
			const next = read(d).value;
			const start = d.start;
			stop();
			if (next !== start) onCommit(next);
		},
		onPointerCancel: stop,
		// Capture can go without a cancel (the element leaves the page), and the
		// drag can't go on without it.
		onLostPointerCapture: stop,
	};

	return {
		handlers,
		dragging: preview !== null,
		// True right after a drag ends; check it in the element's onClick.
		wasDrag: () => dragged.current,
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
				// Steps are wide enough to label every one; the start stands out.
				const major = n === start;
				return (
					<div
						key={n}
						className="absolute top-2 flex -translate-x-1/2 flex-col items-center"
						style={{ left }}
					>
						<div
							className={cn(
								"w-px",
								major ? "h-3 bg-input" : "h-2 bg-line",
								current && "h-3 w-0.5 bg-foreground",
							)}
						/>
						{n === 0 ? (
							<Trash2
								className={cn(
									"mt-1 size-3.5",
									current ? "text-critical-text" : "text-faint",
								)}
							/>
						) : (
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
						)}
					</div>
				);
			})}
		</div>
	);
}
