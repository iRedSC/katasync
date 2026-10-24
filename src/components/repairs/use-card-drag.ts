import { type PointerEvent as ReactPointerEvent, useState } from "react";

// Picking up a card by hand: with a mouse it lifts once moved a few pixels,
// with a finger after a short hold (so a swipe still scrolls the board). It
// follows the pointer and drops on the column under it, marked
// data-column="<id>". Escape puts it back.

export type Lifted<T> = {
	item: T;
	x: number;
	y: number;
	// Where on the card it was grabbed, so it doesn't jump to the pointer.
	grabX: number;
	grabY: number;
	width: number;
	over: string | null;
};

const SLOP_PX = 5;
const HOLD_MS = 200;

const columnAt = (x: number, y: number) =>
	document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-column]")
		?.dataset.column ?? null;

// The click that ends a drag would otherwise open what it was dropped on.
function swallowNextClick() {
	const stop = (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
	};
	window.addEventListener("click", stop, { capture: true, once: true });
	setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

export function useCardDrag<T>(onDrop: (item: T, column: string) => void) {
	const [lifted, setLifted] = useState<Lifted<T> | null>(null);

	function pickUp(e: ReactPointerEvent<HTMLElement>, item: T) {
		if (
			e.button !== 0 ||
			(e.target as Element).closest("button, a[href^='tel:']")
		)
			return;
		const rect = e.currentTarget.getBoundingClientRect();
		const x0 = e.clientX;
		const y0 = e.clientY;
		const touch = e.pointerType === "touch";
		let live: Lifted<T> | null = null;
		let held = !touch;

		const lift = (x: number, y: number) => {
			live = {
				item,
				x,
				y,
				grabX: x0 - rect.left,
				grabY: y0 - rect.top,
				width: rect.width,
				over: columnAt(x, y),
			};
			setLifted(live);
		};
		const timer = touch
			? setTimeout(() => {
					held = true;
					lift(x0, y0);
				}, HOLD_MS)
			: undefined;

		const move = (ev: PointerEvent) => {
			if (live) {
				live = {
					...live,
					x: ev.clientX,
					y: ev.clientY,
					over: columnAt(ev.clientX, ev.clientY),
				};
				setLifted(live);
			} else if (Math.hypot(ev.clientX - x0, ev.clientY - y0) >= SLOP_PX) {
				// A finger moving before the hold is a scroll, not a pickup.
				if (held) lift(ev.clientX, ev.clientY);
				else end();
			}
		};
		// Once lifted, a finger moves the card instead of the page.
		const holdPage = (ev: TouchEvent) => live && ev.preventDefault();
		const noMenu = (ev: Event) => live && ev.preventDefault();
		const up = () => {
			const done = live;
			end();
			if (!done) return;
			swallowNextClick();
			if (done.over) onDrop(done.item, done.over);
		};
		const key = (ev: KeyboardEvent) => ev.key === "Escape" && end();

		function end() {
			clearTimeout(timer);
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", end);
			window.removeEventListener("keydown", key);
			window.removeEventListener("touchmove", holdPage);
			window.removeEventListener("contextmenu", noMenu);
			live = null;
			setLifted(null);
		}
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", end);
		window.addEventListener("keydown", key);
		window.addEventListener("touchmove", holdPage, { passive: false });
		window.addEventListener("contextmenu", noMenu);
	}

	return { lifted, pickUp };
}
