import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { AppSidebar } from "#/components/app-sidebar";
import { CommandPalette } from "#/components/command-palette";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar";
import { TooltipProvider } from "#/components/ui/tooltip";
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
			{ rel: "icon", type: "image/png", href: "/favicon.png" },
		],
	}),
	shellComponent: RootDocument,
	errorComponent: ({ error }) => (
		<div className="mx-auto flex max-w-md flex-col items-center gap-3 py-32 text-center">
			<p className="text-lg font-medium">Something broke on this page</p>
			<p className="text-sm text-muted-foreground">
				{error instanceof Error ? error.message : String(error)}
			</p>
			<a href="/" className="text-sm text-primary underline">
				Back to Today
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
				<TooltipProvider>
					<SidebarProvider defaultOpen={false}>
						<AppSidebar />
						<SidebarInset>{children}</SidebarInset>
					</SidebarProvider>
					<CommandPalette />
				</TooltipProvider>
				<Scripts />
			</body>
		</html>
	);
}
