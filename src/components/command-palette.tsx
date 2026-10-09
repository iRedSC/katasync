import { useNavigate } from "@tanstack/react-router";
import {
	ArrowLeftRight,
	ClipboardList,
	LayoutDashboard,
	Link2,
	Package,
	Settings,
	Truck,
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
import { listProductIndex } from "#/server/catalog";

export const pages = [
	{ to: "/", label: "Today", icon: LayoutDashboard, keys: "g t" },
	{ to: "/orders", label: "Orders", icon: Truck, keys: "g o" },
	{ to: "/products", label: "Products", icon: Package, keys: "g p" },
	{ to: "/stock", label: "Stock history", icon: ArrowLeftRight, keys: "g h" },
	{ to: "/listings", label: "Listings", icon: Link2, keys: "g l" },
	{ to: "/purchasing", label: "Purchasing", icon: ClipboardList, keys: "g b" },
	{ to: "/settings", label: "Settings", icon: Settings, keys: "g s" },
] as const;

// Opens the palette from anywhere, e.g. a button.
export function openFind() {
	window.dispatchEvent(new Event("open-find"));
}

type IndexEntry = Awaited<ReturnType<typeof listProductIndex>>[number];

// ⌘K: jump to any page or product. Also owns the "g x" page shortcuts.
export function CommandPalette() {
	const navigate = useNavigate();
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
			<DialogContent className="overflow-hidden p-0" showCloseButton={false}>
				<DialogTitle className="sr-only">Find</DialogTitle>
				<DialogDescription className="sr-only">
					Find a product or page
				</DialogDescription>
				<Command
					shouldFilter={false}
					className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5"
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
