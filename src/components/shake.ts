// A sideways shake, for something that didn't go through. Skipped for anyone
// who asks for less motion.
export function shake(el: HTMLElement | null) {
	if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	el.animate(
		[0, -6, 6, -4, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })),
		{ duration: 300 },
	);
}
