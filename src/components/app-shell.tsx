import { Link, useLoaderData, useLocation } from "@tanstack/react-router";
import { Menu, Search } from "lucide-react";
import { type ReactNode, Suspense, use, useEffect, useState } from "react";
import { openFind, pages } from "#/components/command-palette";
import { Saving } from "#/components/saving";
import { Tip } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import type { NavCounts } from "#/server/nav";

type NavPage = (typeof pages)[number];

const top = pages.filter((p) => p.parent === null && p.to !== "/settings");
const settings = pages.find((p) => p.to === "/settings");
const childrenOf = (to: string) => pages.filter((p) => p.parent === to);
const matches = (to: string, pathname: string) =>
	to === "/" ? pathname === "/" : pathname.startsWith(to);
// A section is active while you're on it, but not on a sub-page that has its
// own nav item (Purchase orders stays unlit on Suppliers).
const isActive = (to: string, pathname: string) =>
	matches(to, pathname) && !childrenOf(to).some((k) => matches(k.to, pathname));
const inSection = (to: string, pathname: string) =>
	matches(to, pathname) || childrenOf(to).some((k) => matches(k.to, pathname));

// Print pages are the paper itself: no bars, no nav. The receiving app is
// its own full-screen phone app. Signing in comes before the app.
export const isBare = (pathname: string) =>
	pathname.startsWith("/print") ||
	pathname.startsWith("/receive") ||
	pathname === "/login" ||
	pathname === "/setup";

// The Shopify-admin frame: a dark top bar with search, a gray left nav, and
// the page on a light gray background.
export function AppShell({ children }: { children: ReactNode }) {
	const [navOpen, setNavOpen] = useState(false);
	const pathname = useLocation({ select: (l) => l.pathname });
	// biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile nav after navigating
	useEffect(() => setNavOpen(false), [pathname]);
	const { navCounts } = useLoaderData({ from: "__root__" });

	if (isBare(pathname)) return children;

	return (
		<div className="flex min-h-svh flex-col">
			<header className="sticky top-0 z-30 flex h-14 items-center gap-3 bg-topbar px-3 text-white">
				<button
					type="button"
					className="rounded-lg p-1.5 text-white/80 hover:bg-white/10 md:hidden"
					onClick={() => setNavOpen((o) => !o)}
					aria-label="Menu"
				>
					<Menu className="size-5" />
				</button>
				<Link to="/" className="flex items-center gap-2 md:w-[13rem] md:pl-1">
					<img src="/logo.svg" alt="" className="size-7 object-contain" />
					<span className="text-sm font-semibold">katasync</span>
				</Link>
				<button
					type="button"
					onClick={openFind}
					className="mx-auto flex h-9 w-full max-w-xl items-center gap-2 rounded-lg bg-white/10 px-3 text-left text-white/60 hover:bg-white/15"
				>
					<Search className="size-4" />
					<span className="flex-1">Search</span>
					<kbd className="rounded bg-white/10 px-1.5 text-xs">⌘ K</kbd>
				</button>
				<div className="hidden justify-end md:flex md:w-[13rem]">
					<Saving className="pr-2 text-xs text-white/60" />
				</div>
			</header>

			<div className="flex flex-1">
				<nav
					className={cn(
						"fixed inset-y-0 top-14 z-20 w-60 flex-col justify-between bg-nav p-3 md:sticky md:flex md:h-[calc(100svh-3.5rem)]",
						navOpen ? "flex" : "hidden",
					)}
				>
					<NavSection items={top} pathname={pathname} counts={navCounts} />
					{settings && (
						<NavSection
							items={[settings]}
							pathname={pathname}
							counts={navCounts}
							flagHidden
						/>
					)}
				</nav>
				<main className="min-w-0 flex-1">{children}</main>
			</div>
		</div>
	);
}

function NavSection({
	items,
	pathname,
	counts,
	flagHidden = false,
}: {
	items: NavPage[];
	pathname: string;
	counts: Promise<NavCounts | null> | null;
	flagHidden?: boolean;
}) {
	return (
		<ul className="flex flex-col gap-0.5">
			{items.map((p) => {
				const kids = childrenOf(p.to);
				// Like Shopify, a section's sub-pages show while you're in it.
				const open = inSection(p.to, pathname);
				return (
					<li key={p.to}>
						<NavItem
							page={p}
							pathname={pathname}
							counts={counts}
							// Closed Settings still says when one of its tools has a
							// problem. Routine work (counts due) doesn't get a dot.
							hidden={open || !flagHidden ? [] : kids}
						/>
						{open && kids.length > 0 && (
							<ul className="mt-0.5 flex flex-col gap-0.5">
								{kids.map((k) => (
									<li key={k.to}>
										<NavItem
											page={k}
											pathname={pathname}
											counts={counts}
											child
										/>
									</li>
								))}
							</ul>
						)}
					</li>
				);
			})}
		</ul>
	);
}

function NavItem({
	page: { to, label, icon: Icon, keys, count },
	pathname,
	counts,
	hidden = [],
	child = false,
}: {
	page: NavPage;
	pathname: string;
	counts: Promise<NavCounts | null> | null;
	hidden?: NavPage[];
	child?: boolean;
}) {
	const active = isActive(to, pathname);
	return (
		<Tip side="right" content={`${label} (${keys.toUpperCase()})`}>
			<Link
				to={to}
				className={cn(
					"flex h-8 items-center gap-2 rounded-lg px-2 text-[0.8125rem] text-foreground",
					child ? "pl-8 font-normal" : "font-medium",
					active ? "bg-white font-semibold" : "hover:bg-surface-strong",
				)}
			>
				{!child && (
					<Icon
						className={cn(
							"size-4",
							active ? "text-foreground" : "text-muted-foreground",
						)}
					/>
				)}
				<span className="flex-1 truncate">{label}</span>
				{counts && (
					<Suspense>
						<Waiting
							counts={counts}
							own={count}
							hidden={hidden.flatMap((k) => (k.count ? [k.count] : []))}
						/>
					</Suspense>
				)}
			</Link>
		</Tip>
	);
}

// Work is routine (orders to ship); a problem means something is broken and
// shows red. Every count has to say which it is.
const problem: Record<keyof NavCounts, boolean> = {
	toShip: false,
	posReady: false,
	countsDue: false,
	unmatched: true,
	attention: true,
};

// The item's own count as a pill, or a dot when only its hidden sub-pages
// have something waiting.
function Waiting({
	counts,
	own,
	hidden,
}: {
	counts: Promise<NavCounts | null>;
	own: keyof NavCounts | null;
	hidden: (keyof NavCounts)[];
}) {
	const c = use(counts);
	if (!c) return null;
	if (own && c[own] > 0)
		return (
			<span
				className={cn(
					"rounded-md px-1.5 text-xs font-medium tabular-nums",
					problem[own]
						? "bg-critical-fill text-critical-text"
						: "bg-surface-strong",
				)}
			>
				{c[own] > 999 ? "999+" : c[own]}
			</span>
		);
	if (hidden.some((k) => problem[k] && c[k] > 0))
		return <span className="size-1.5 rounded-full bg-critical-icon" />;
	return null;
}
