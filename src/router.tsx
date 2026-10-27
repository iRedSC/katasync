import {
	type AnyRoute,
	createRouter as createTanStackRouter,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { Bone, ListSkeleton } from "./components/skeleton";
import { getContext } from "./integrations/tanstack-query/root-provider";
import { connectOptimism, optimism } from "./lib/optimism";
import { invalidateProductIndex } from "./lib/product-index";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const context = getContext();

	const router = createTanStackRouter({
		routeTree,
		context,
		scrollRestoration: true,
		defaultPreload: "intent",
		// Data preloaded on hover stays fresh long enough to be used by the click.
		defaultPreloadStaleTime: 30_000,
		// A click leaves at once: the next page's skeleton shows while its data
		// loads, rather than the old page sitting there for a second. Pages
		// already loaded show their last data while it refreshes, so they skip
		// the skeleton; so do reloads after a change. No minimum, so a fast
		// load isn't held back to hide a flicker.
		defaultPendingMs: 0,
		defaultPendingMinMs: 0,
		defaultPendingComponent: () => (
			<ListSkeleton title={<Bone className="h-6 w-40" />} />
		),
	});

	setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient });
	// Changes show at once; the page reloads once the server has them all.
	// sync, so the reload resolves once the new data shows rather than while
	// it still loads in the background; until then the patches stay up.
	connectOptimism(() => router.invalidate({ sync: true }));
	for (const route of Object.values(router.routesById)) throughOptimism(route);

	// Every load, whether after a change here, a sync, or moving around, may
	// have changed products, so the product index reloads where it's showing.
	router.subscribe("onBeforeLoad", () =>
		invalidateProductIndex(context.queryClient),
	);

	return router;
}

// Every loader loads through the engine, so its data is marked with when it
// was fetched rather than when it first shows: a page preloaded on hover
// before a change, and opened after, still gets the change's patch. Routes
// outlive a router on the server, so each is wrapped once.
const wrapped = new WeakSet<object>();
function throughOptimism(route: AnyRoute) {
	const loader = route.options.loader;
	if (wrapped.has(route) || !loader) return;
	wrapped.add(route);
	const through = (load: (ctx: unknown) => unknown) => (ctx: unknown) =>
		optimism.load(() => load(ctx));
	route.options.loader =
		typeof loader === "function"
			? through(loader)
			: { ...loader, handler: through(loader.handler) };
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
