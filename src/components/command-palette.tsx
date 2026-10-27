import { useNavigate } from "@tanstack/react-router";
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
import { pageHotkeys, pages } from "#/components/pages";
import { useHotkeys } from "#/lib/hotkeys";
import { productSearch } from "#/lib/product-search";
import { useRowLink } from "#/lib/row-link";
import { matchText, textMatcher } from "#/lib/search-ranking";
import { listProductIndex } from "#/server/catalog";

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

	useHotkeys(pageHotkeys(pages, (p) => navigate({ to: p.to })));

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
	const q = query.trim();
	const matches =
		q.length < 2 || !index ? [] : productSearch(index, q, { limit: 30 });
	const pageMatches = textMatcher(q);

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
								.filter((p) => pageMatches(matchText(p.label)))
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
