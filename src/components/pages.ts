import {
	Activity,
	ArrowLeftRight,
	ChartNoAxesColumnIncreasing,
	ClipboardList,
	Factory,
	FileSpreadsheet,
	Inbox,
	LayoutDashboard,
	Library,
	Link2,
	ListChecks,
	Package,
	Settings,
	Shuffle,
	Store,
	Trophy,
	Truck,
	Undo2,
	Users,
	Wrench,
} from "lucide-react";
import type { NavCounts } from "#/server/nav";

// The sidebar holds only the places staff go to do work, each with a count of
// what's waiting there (a key of NavCounts). Admin tools sit under Settings.
// A page with a parent shows under it while you're in that section.
export const pages = [
	{
		to: "/",
		label: "Home",
		icon: LayoutDashboard,
		keys: "g h",
		parent: null,
		count: null,
	},
	{
		to: "/orders",
		label: "Orders",
		icon: Truck,
		keys: "g o",
		parent: null,
		count: "toShip",
	},
	{
		to: "/orders/returns",
		label: "Returns & refunds",
		icon: Undo2,
		keys: "g e",
		parent: "/orders",
		count: "returnsDue",
	},
	{
		to: "/inbox",
		label: "Inbox",
		icon: Inbox,
		keys: "g f",
		parent: null,
		count: "inbox",
	},
	{
		to: "/analytics",
		label: "Analytics",
		icon: ChartNoAxesColumnIncreasing,
		keys: "g r",
		parent: null,
		count: null,
	},
	{
		to: "/profit",
		label: "Profit",
		icon: Trophy,
		keys: "g m",
		parent: "/analytics",
		count: null,
	},
	{
		to: "/markets",
		label: "Markets",
		icon: Store,
		keys: "g k",
		parent: "/analytics",
		count: "atRisk",
	},
	{
		to: "/reports",
		label: "Reports",
		icon: FileSpreadsheet,
		keys: "g a",
		parent: "/analytics",
		count: null,
	},
	{
		to: "/reconciliation",
		label: "Reconciliation",
		icon: ListChecks,
		keys: "g x",
		parent: "/analytics",
		count: null,
	},
	{
		to: "/products",
		label: "Products",
		icon: Package,
		keys: "g p",
		parent: null,
		count: null,
	},
	{
		to: "/counts",
		label: "Cycle counts",
		icon: ListChecks,
		keys: "g n",
		parent: "/products",
		count: "countsDue",
	},
	{
		to: "/transfers",
		label: "Transfers",
		icon: Shuffle,
		keys: "g t",
		parent: "/products",
		count: null,
	},
	{
		to: "/purchasing",
		label: "Purchase orders",
		icon: ClipboardList,
		keys: "g b",
		parent: null,
		count: "posReady",
	},
	{
		to: "/purchasing/suppliers",
		label: "Suppliers",
		icon: Factory,
		keys: "g v",
		parent: "/purchasing",
		count: null,
	},
	{
		to: "/purchasing/catalogs",
		label: "Catalogs",
		icon: Library,
		keys: "g c",
		parent: "/purchasing",
		count: null,
	},
	{
		to: "/repairs",
		label: "Repairs",
		icon: Wrench,
		keys: "g w",
		parent: null,
		count: "repairsToDo",
	},
	{
		to: "/repairs/customers",
		label: "Customers",
		icon: Users,
		keys: "g u",
		parent: "/repairs",
		count: null,
	},
	{
		to: "/settings",
		label: "Settings",
		icon: Settings,
		keys: "g s",
		parent: null,
		count: null,
	},
	{
		to: "/diagnostics",
		label: "Diagnostics",
		icon: Activity,
		keys: "g d",
		parent: "/settings",
		count: "attention",
	},
	{
		to: "/listings",
		label: "Unmatched listings",
		icon: Link2,
		keys: "g l",
		parent: "/settings",
		count: "unmatched",
	},
	{
		to: "/stock",
		label: "Inventory history",
		icon: ArrowLeftRight,
		keys: "g i",
		parent: "/settings",
		count: null,
	},
] as const satisfies readonly {
	to: string;
	label: string;
	icon: unknown;
	keys: string;
	parent: string | null;
	count: keyof NavCounts | null;
}[];

// The "g x" shortcut for each page. Two pages sharing one would leave the
// later unreachable, so a duplicate fails here rather than going unnoticed.
export function pageHotkeys<P extends { keys: string; label: string }>(
	list: readonly P[],
	go: (page: P) => void,
) {
	const bindings: Record<string, () => void> = {};
	for (const p of list) {
		if (p.keys in bindings)
			throw new Error(`${p.label} shares the shortcut "${p.keys}"`);
		bindings[p.keys] = () => go(p);
	}
	return bindings;
}
