import { type RefObject, useEffect, useRef } from "react";

// Opens quick ship already on this order, past the pin step (the order
// page's Ship button).
export function openQuickShip(pin: number) {
	window.dispatchEvent(new CustomEvent("quick-ship", { detail: pin }));
}

// Ctrl+Space toggles quick ship anywhere, and openQuickShip opens it on an
// order. Neither does anything while a label is being bought.
export function useOpening({
	buying,
	toggle,
	openOn,
}: {
	buying: RefObject<boolean>;
	toggle: () => void;
	openOn: (pin: number) => void;
}) {
	const latest = useRef({ toggle, openOn });
	latest.current = { toggle, openOn };
	// biome-ignore lint/correctness/useExhaustiveDependencies: buying is a ref
	useEffect(() => {
		function onKeyDown(e: globalThis.KeyboardEvent) {
			if (e.ctrlKey && e.code === "Space") {
				e.preventDefault();
				if (buying.current) return;
				latest.current.toggle();
			}
		}
		function onOpen(e: Event) {
			if (buying.current) return;
			latest.current.openOn((e as CustomEvent<number>).detail);
		}
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("quick-ship", onOpen);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("quick-ship", onOpen);
		};
	}, []);
}
