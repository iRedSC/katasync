import { Link, useLocation } from "@tanstack/react-router";
import { Menu, Search } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { openFind, pages } from "#/components/command-palette";
import { cn } from "#/lib/utils";

const top = pages.filter((p) => p.parent === null && p.to !== "/settings");
const settings = pages.find((p) => p.to === "/settings");
const childrenOf = (to: string) => pages.filter((p) => p.parent === to);
const isActive = (to: string, pathname: string) =>
	to === "/" ? pathname === "/" : pathname.startsWith(to);

// The Shopify-admin frame: a dark top bar with search, a gray left nav, and
// the page on a light gray background.
export function AppShell({ children }: { children: ReactNode }) {
	const [navOpen, setNavOpen] = useState(false);
	const pathname = useLocation({ select: (l) => l.pathname });
	// biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile nav after navigating
	useEffect(() => setNavOpen(false), [pathname]);

	// Print pages are the paper itself: no bars, no nav. The receiving app is
	// its own full-screen phone app.
	if (pathname.startsWith("/print") || pathname.startsWith("/receive"))
		return children;

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
				<div className="hidden md:block md:w-[13rem]" />
			</header>

			<div className="flex flex-1">
				<nav
					className={cn(
						"fixed inset-y-0 top-14 z-20 w-60 flex-col justify-between bg-nav p-3 md:sticky md:flex md:h-[calc(100svh-3.5rem)]",
						navOpen ? "flex" : "hidden",
					)}
				>
					<ul className="flex flex-col gap-0.5">
						{top.map((p) => {
							const kids = childrenOf(p.to);
							// Like Shopify, a section's sub-pages show while you're in it.
							const open =
								isActive(p.to, pathname) ||
								kids.some((k) => isActive(k.to, pathname));
							return (
								<li key={p.to}>
									<NavItem {...p} pathname={pathname} />
									{open && kids.length > 0 && (
										<ul className="mt-0.5 flex flex-col gap-0.5">
											{kids.map((k) => (
												<li key={k.to}>
													<NavItem {...k} pathname={pathname} child />
												</li>
											))}
										</ul>
									)}
								</li>
							);
						})}
					</ul>
					{settings && <NavItem {...settings} pathname={pathname} />}
				</nav>
				<main className="min-w-0 flex-1">{children}</main>
			</div>
		</div>
	);
}

function NavItem({
	to,
	label,
	icon: Icon,
	keys,
	pathname,
	child = false,
}: (typeof pages)[number] & { pathname: string; child?: boolean }) {
	const active = isActive(to, pathname);
	return (
		<Link
			to={to}
			title={`${label} (${keys.toUpperCase()})`}
			className={cn(
				"flex h-8 items-center gap-2 rounded-lg px-2 text-[0.8125rem] text-[#303030]",
				child ? "pl-8 font-normal" : "font-medium",
				active ? "bg-white font-semibold" : "hover:bg-[#e3e3e3]",
			)}
		>
			{!child && (
				<Icon
					className={cn("size-4", active ? "text-[#303030]" : "text-[#4a4a4a]")}
				/>
			)}
			{label}
		</Link>
	);
}
