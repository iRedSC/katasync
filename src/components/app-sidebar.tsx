import { Link, useLocation } from "@tanstack/react-router";
import {
	ArrowLeftRight,
	ClipboardList,
	LayoutDashboard,
	Link2,
	Package,
	Settings,
	Truck,
} from "lucide-react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "#/components/ui/sidebar";

const sections = [
	{
		label: null,
		items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }],
	},
	{
		label: "Fulfillment",
		items: [{ to: "/orders", label: "Orders", icon: Truck }],
	},
	{
		label: "Inventory",
		items: [
			{ to: "/products", label: "Products", icon: Package },
			{ to: "/stock", label: "Stock movements", icon: ArrowLeftRight },
			{ to: "/listings", label: "Listings", icon: Link2 },
		],
	},
	{
		label: "Purchasing",
		items: [
			{ to: "/purchasing", label: "Purchase orders", icon: ClipboardList },
		],
	},
] as const;

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
				{sections.map((section) => (
					<SidebarGroup key={section.label ?? "home"}>
						{section.label && (
							<SidebarGroupLabel>{section.label}</SidebarGroupLabel>
						)}
						<SidebarGroupContent>
							<SidebarMenu>
								{section.items.map((item) => (
									<SidebarMenuItem key={item.to}>
										<NavButton {...item} />
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<NavButton to="/settings" label="Settings" icon={Settings} />
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}

function NavButton({
	to,
	label,
	icon: Icon,
}: {
	to: string;
	label: string;
	icon: typeof Settings;
}) {
	const pathname = useLocation({ select: (l) => l.pathname });
	const isActive = to === "/" ? pathname === "/" : pathname.startsWith(to);
	return (
		<SidebarMenuButton asChild isActive={isActive} tooltip={label}>
			<Link to={to}>
				<Icon />
				<span>{label}</span>
			</Link>
		</SidebarMenuButton>
	);
}
