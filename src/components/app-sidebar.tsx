import { Link, useLocation } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { openFind, pages } from "#/components/command-palette";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "#/components/ui/sidebar";

const main = pages.filter((p) => p.to !== "/settings");
const settings = pages.filter((p) => p.to === "/settings");

export function AppSidebar() {
	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" asChild>
							<Link to="/">
								<img src="/logo.png" alt="" className="size-8 object-contain" />
								<span className="text-base font-semibold tracking-tight">
									katasync
								</span>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton
									tooltip="Find (⌘K)"
									className="text-muted-foreground"
									onClick={openFind}
								>
									<Search />
									<span>Find</span>
									<kbd className="ml-auto text-xs">⌘K</kbd>
								</SidebarMenuButton>
							</SidebarMenuItem>
							{main.map((p) => (
								<SidebarMenuItem key={p.to}>
									<NavButton {...p} />
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					{settings.map((p) => (
						<SidebarMenuItem key={p.to}>
							<NavButton {...p} />
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}

function NavButton({ to, label, icon: Icon, keys }: (typeof pages)[number]) {
	const pathname = useLocation({ select: (l) => l.pathname });
	const isActive = to === "/" ? pathname === "/" : pathname.startsWith(to);
	return (
		<SidebarMenuButton
			asChild
			isActive={isActive}
			tooltip={`${label} (${keys.toUpperCase()})`}
		>
			<Link to={to}>
				<Icon />
				<span>{label}</span>
			</Link>
		</SidebarMenuButton>
	);
}
