import { useNavigate } from "@tanstack/react-router";
import {
	Activity,
	ArrowLeftRight,
	ChartNoAxesColumnIncreasing,
	ClipboardList,
	Factory,
	FileSpreadsheet,
	Inbox,
	LayoutDashboard,
	Link2,
	ListChecks,
	Package,
	Settings,
	Shuffle,
	Store,
	Trophy,
	Truck,
	Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "#/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { useHotkeys } from "#/lib/hotkeys";
import { useRowLink } from "#/lib/row-link";
import { listProductIndex } from "#/server/catalog";
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
		to: "/inbox",
		label: "Inbox",
		icon: Inbox,
		keys: "g f",
		parent: "/",
		count: "inbox",
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
		label: "Returns",
		icon: Undo2,
		keys: "g e",
		parent: "/orders",
		count: "returnsDue",
	},
	{
		to: "/profit",
		label: "Profit",
		icon: ChartNoAxesColumnIncreasing,
		keys: "g m",
		parent: null,
		count: null,
	},
	{
		to: "/profit/overview",
		label: "Profit overview",
		icon: Trophy,
		keys: "g r",
		parent: "/profit",
		count: null,
	},
	{
		to: "/reports",
		label: "Reports",
		icon: FileSpreadsheet,
		keys: "g a",
		parent: "/profit",
		count: null,
	},
	{
		to: "/markets",
		label: "Markets",
		icon: Store,
		keys: "g k",
		parent: null,
		count: "atRisk",
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

// Opens the palette from anywhere, e.g. a button.
export function openFind() {
	window.dispatchEvent(new Event("open-find"));
}

type IndexEntry = Awaited<ReturnType<typeof listProductIndex>>[number];

// ⌘K: jump to any page or product. Also owns the "g x" page shortcuts.
export function CommandPalette() {
	const navigate = useNavigate();
	const { preload } = useRowLink();
	const [open, setOpen] = useState(false);
	const [index, setIndex] = useState<IndexEntry[] | null>(null);
	const [query, setQuery] = useState("");

	useHotkeys(
		Object.fromEntries(
			pages.map((p) => [p.keys, () => navigate({ to: p.to })]),
		),
	);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpen((o) => !o);
			}
		}
		const onOpenFind = () => setOpen(true);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("open-find", onOpenFind);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("open-find", onOpenFind);
		};
	}, []);

	useEffect(() => {
		if (open && index === null) listProductIndex().then(setIndex);
	}, [open, index]);

	// cmdk filters fine on its own, but rendering thousands of items is slow;
	// only render matches once someone types.
	const q = query.trim().toLowerCase();
	const matches =
		q.length < 2 || !index
			? []
			: index
					.filter(
						(p) =>
							p.sku.toLowerCase().includes(q) ||
							p.name.toLowerCase().includes(q),
					)
					.slice(0, 30);

	function go(to: () => void) {
		setOpen(false);
		setQuery("");
		to();
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="overflow-hidden p-0 sm:max-w-2xl"
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">Find</DialogTitle>
				<DialogDescription className="sr-only">
					Find a product or page
				</DialogDescription>
				<Command
					shouldFilter={false}
					// The highlighted product or page loads ahead, so Enter shows it
					// at once.
					onValueChange={(v) => {
						const p = matches.find((m) => m.sku === v);
						if (p) preload({ to: "/products/$sku", params: { sku: p.sku } });
						const page = pages.find((x) => x.to === v);
						if (page) preload({ to: page.to });
					}}
				>
					<CommandInput
						placeholder="Find a product or page…"
						value={query}
						onValueChange={setQuery}
					/>
					<CommandList>
						<CommandEmpty>Nothing matches.</CommandEmpty>
						{matches.length > 0 && (
							<CommandGroup heading="Products">
								{matches.map((p) => (
									<CommandItem
										key={p.sku}
										value={p.sku}
										onSelect={() =>
											go(() =>
												navigate({
													to: "/products/$sku",
													params: { sku: p.sku },
												}),
											)
										}
									>
										<Package />
										<span className="truncate">
											{p.name}
											{p.variantName && (
												<span className="text-muted-foreground">
													{" "}
													· {p.variantName}
												</span>
											)}
										</span>
										<CommandShortcut className="tracking-normal">
											{p.sku}
										</CommandShortcut>
									</CommandItem>
								))}
							</CommandGroup>
						)}
						<CommandGroup heading="Go to">
							{pages
								.filter((p) => q === "" || p.label.toLowerCase().includes(q))
								.map((p) => (
									<CommandItem
										key={p.to}
										value={p.to}
										onSelect={() => go(() => navigate({ to: p.to }))}
									>
										<p.icon />
										{p.label}
										<CommandShortcut>{p.keys.toUpperCase()}</CommandShortcut>
									</CommandItem>
								))}
						</CommandGroup>
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
