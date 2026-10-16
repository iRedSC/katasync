import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { getContext } from "./integrations/tanstack-query/root-provider";
import { connectOptimism } from "./lib/optimism";
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
	});

	setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient });
	// Changes show at once; the page reloads once the server has them all.
	connectOptimism(() => router.invalidate());

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
