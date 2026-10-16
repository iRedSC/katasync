import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { Toaster } from "sonner";
import { AppShell, isBare } from "#/components/app-shell";
import { CommandPalette } from "#/components/command-palette";
import { QuickShip } from "#/components/quick-ship";
import "#/lib/undo";
import { getNavCounts } from "#/server/nav";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "katasync" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
		],
	}),
	// The sidebar's counts, deferred so they never hold up a page. They
	// refresh with every router.invalidate(), so they follow staff's actions.
	// Pages without the sidebar skip them; signing in reloads the whole page.
	loader: ({ location }) => ({
		navCounts: isBare(location.pathname)
			? null
			: getNavCounts().catch(() => null),
	}),
	staleTime: 30_000,
	shellComponent: RootDocument,
	errorComponent: ({ error }) => (
		<div className="mx-auto flex max-w-md flex-col items-center gap-3 py-32 text-center">
			<p className="text-base font-semibold">This page couldn't load</p>
			<p className="text-muted-foreground">
				{error instanceof Error ? error.message : String(error)}
			</p>
			<a href="/" className="text-link hover:underline">
				Go to Home
			</a>
		</div>
	),
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<AppShell>{children}</AppShell>
				<CommandPalette />
				<QuickShip />
				<Toaster
					position="bottom-center"
					toastOptions={{
						// Shopify's toast: a dark pill at the bottom of the screen.
						classNames: {
							toast:
								"!bg-topbar !border-0 !text-white !rounded-xl !text-[0.8125rem]",
							description: "!text-white/70",
							actionButton:
								"!bg-white !text-foreground !font-semibold !rounded-lg",
						},
					}}
				/>
				<Scripts />
			</body>
		</html>
	);
}
