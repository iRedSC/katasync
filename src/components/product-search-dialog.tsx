import { type ReactNode, useEffect, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { listProductIndex } from "#/server/catalog";

export type IndexEntry = Awaited<ReturnType<typeof listProductIndex>>[number];

// Picks one product by SKU or name. Open while `title` is set; it says what
// the pick is for.
export function ProductSearchDialog({
	title,
	startFrom,
	onPick,
	onClose,
}: {
	title: ReactNode | null;
	// A SKU from elsewhere, usually close to the right one; its first part
	// starts the search.
	startFrom?: string | null;
	onPick: (product: IndexEntry) => void;
	onClose: () => void;
}) {
	const open = title !== null;
	const [products, setProducts] = useState<IndexEntry[] | null>(null);
	const [query, setQuery] = useState("");

	useEffect(() => {
		if (!open) return;
		// Fresh each time, so products made since show up.
		listProductIndex().then(setProducts);
		setQuery(startFrom?.split(/[-_ ]/)[0] ?? "");
	}, [open, startFrom]);

	const q = query.trim().toLowerCase();
	const matches =
		!products || q.length < 2
			? []
			: products
					.filter(
						(p) =>
							p.sku.toLowerCase().includes(q) ||
							p.name.toLowerCase().includes(q),
					)
					.slice(0, 40);

	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="overflow-hidden p-0" showCloseButton={false}>
				<DialogTitle className="sr-only">Pick a product</DialogTitle>
				<DialogDescription className="border-b px-4 py-3 text-foreground">
					{title}
				</DialogDescription>
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="SKU or name"
						value={query}
						onValueChange={setQuery}
					/>
					<CommandList>
						<CommandEmpty>
							{products === null
								? "Loading products…"
								: q.length < 2
									? "Type at least 2 letters."
									: "No products match."}
						</CommandEmpty>
						{matches.length > 0 && (
							<CommandGroup>
								{matches.map((p) => (
									<CommandItem
										key={p.sku}
										value={p.sku}
										onSelect={() => onPick(p)}
									>
										<span className="truncate">
											{p.name}
											{p.variantName && (
												<span className="text-muted-foreground">
													{" "}
													{p.variantName}
												</span>
											)}
										</span>
										<span className="ml-auto shrink-0 text-xs text-muted-foreground">
											{p.sku}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
