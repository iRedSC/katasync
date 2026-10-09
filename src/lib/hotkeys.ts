import { useEffect, useRef } from "react";

function isTyping(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
	);
}

// Single keys ("j", "/", "Escape") and two-key sequences ("g p"). Ignored while
// typing in a field, except Escape. The latest handlers are always used, so
// callers can pass inline functions.
export function useHotkeys(
	bindings: Record<string, (e: KeyboardEvent) => void>,
) {
	const latest = useRef(bindings);
	latest.current = bindings;

	useEffect(() => {
		let pending: string | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;

		function onKeyDown(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key !== "Escape" && isTyping(e.target)) return;

			const sequence = pending ? `${pending} ${e.key}` : null;
			const handler =
				(sequence && latest.current[sequence]) || latest.current[e.key];
			pending = null;
			clearTimeout(timer);

			if (handler) {
				e.preventDefault();
				handler(e);
			} else if (
				Object.keys(latest.current).some((k) => k.startsWith(`${e.key} `))
			) {
				pending = e.key;
				timer = setTimeout(() => {
					pending = null;
				}, 1000);
			}
		}

		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			clearTimeout(timer);
		};
	}, []);
}
