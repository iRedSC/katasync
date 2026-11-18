import { type RefObject, useCallback, useEffect, useRef } from "react";

// How long after an add the row keeps its place on screen: long enough for
// the reload that follows it, which brings a tool set's parts in as rows
// above the list seconds later. Scrolling ends it sooner.
const SETTLE_MS = 15_000;

type Hold = {
	productId: number;
	// Where the row sits in the page, not the window, so scrolling isn't read
	// as the layout moving.
	top: number;
	until: number;
	frame: number;
};

const rowOf = (list: HTMLElement | null, productId: number) =>
	list?.querySelector<HTMLElement>(`[data-product-id="${productId}"]`) ?? null;

const pageTop = (el: HTMLElement) =>
	el.getBoundingClientRect().top + window.scrollY;

const SCROLL_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	" ",
]);

// Adding from the list puts a line on the PO above it, and the reload after
// it can move rows around, which would push what was clicked out from under
// the pointer. `hold(productId)` keeps that row where it is on screen while
// the add settles: the page scrolls by however far the row moved, so new
// lines grow upward, out of view. The row itself is held, not the list, so a
// row that sorts somewhere else afterwards can't put a different product
// under the pointer.
//
// Checked every frame, before the browser paints, rather than on a resize:
// a line added above and a row gone below leave the page the same size, so
// nothing would fire. A resize watch stays as well, for layout that changes
// after the frame's check.
export function useHoldInPlace(listRef: RefObject<HTMLElement | null>) {
	const hold = useRef<Hold | null>(null);

	const release = useCallback(() => {
		const h = hold.current;
		if (!h) return;
		cancelAnimationFrame(h.frame);
		hold.current = null;
		// The browser's own scroll anchoring would correct the same move again.
		document.documentElement.style.overflowAnchor = "";
	}, []);

	const keep = useCallback(() => {
		const h = hold.current;
		if (!h) return;
		const row = rowOf(listRef.current, h.productId);
		if (!row || Date.now() > h.until) {
			release();
			return;
		}
		const top = pageTop(row);
		const moved = top - h.top;
		if (Math.abs(moved) < 1) return;
		h.top = top;
		window.scrollBy(0, moved);
	}, [listRef, release]);

	const tick = useCallback(() => {
		keep();
		const h = hold.current;
		if (h) h.frame = requestAnimationFrame(tick);
	}, [keep]);

	useEffect(() => {
		const watch = new ResizeObserver(keep);
		watch.observe(document.body);
		if (listRef.current) watch.observe(listRef.current);
		// Scrolling by hand, or leaving, hands the page back to the browser:
		// what the person scrolls stays theirs.
		const onKey = (e: KeyboardEvent) => {
			if (SCROLL_KEYS.has(e.key)) release();
		};
		window.addEventListener("wheel", release, { passive: true });
		window.addEventListener("touchmove", release, { passive: true });
		window.addEventListener("keydown", onKey);
		return () => {
			watch.disconnect();
			window.removeEventListener("wheel", release);
			window.removeEventListener("touchmove", release);
			window.removeEventListener("keydown", onKey);
			release();
		};
	}, [listRef, keep, release]);

	return useCallback(
		(productId: number) => {
			const row = rowOf(listRef.current, productId);
			if (!row) return;
			// A second add holds the row clicked now, where the pointer is.
			release();
			document.documentElement.style.overflowAnchor = "none";
			const h: Hold = {
				productId,
				top: pageTop(row),
				until: Date.now() + SETTLE_MS,
				frame: 0,
			};
			hold.current = h;
			h.frame = requestAnimationFrame(tick);
		},
		[listRef, release, tick],
	);
}
