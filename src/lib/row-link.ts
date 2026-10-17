import {
	type NavigateOptions,
	type RegisteredRouter,
	useRouter,
} from "@tanstack/react-router";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useRef,
} from "react";

type To<TTo extends string> = NavigateOptions<RegisteredRouter, string, TTo>;

// Table rows and tiles that open a page, behaving like links: the page's
// data starts loading on hover, so it's usually there by the click, and
// ⌘-click or a middle click opens it in a new tab. One destination drives
// both, so what's preloaded is always what's opened.
//
//   const { link } = useRowLink();
//   <tr {...link({ to: "/orders/$id", params: { id } })}>
export function useRowLink() {
	const router = useRouter();
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	// Loads the page into the router's cache without going there. A failure
	// is left for the real navigation to show.
	const load = useCallback(
		<TTo extends string>(to: To<TTo>) => {
			router.preloadRoute(to as To<string>).catch(() => {});
		},
		[router],
	);
	// Like Link, wait a beat so sweeping the pointer (or holding j) across a
	// list doesn't load every row it passes. A newer target replaces it.
	const preload = useCallback(
		<TTo extends string>(to: To<TTo>) => {
			clearTimeout(timer.current);
			timer.current = setTimeout(
				() => load(to),
				router.options.defaultPreloadDelay ?? 50,
			);
		},
		[router, load],
	);

	const link = useCallback(
		<TTo extends string>(to: To<TTo>) => {
			const newTab = () =>
				window.open(router.buildLocation(to as To<string>).href, "_blank");
			const open = (e: MouseEvent | KeyboardEvent) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey) newTab();
				else void router.navigate(to as To<string>);
			};
			return {
				onClick: open,
				onKeyDown: (e: KeyboardEvent) => e.key === "Enter" && open(e),
				onAuxClick: (e: MouseEvent) => {
					if (e.button !== 1) return;
					e.preventDefault();
					newTab();
				},
				onMouseEnter: () => preload(to),
				onMouseLeave: () => clearTimeout(timer.current),
				// A finger lifts about a tenth of a second after it lands.
				onTouchStart: () => load(to),
			};
		},
		[router, preload, load],
	);

	return { link, preload, load };
}

export type RowLinkProps = ReturnType<ReturnType<typeof useRowLink>["link"]>;
