import { ArrowRight, Library, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CatalogMark } from "#/components/catalog-mark";
import { CatalogOption } from "#/components/catalog-picker";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
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
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { formatCount } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import type { ProductRow } from "#/server/catalog";
import {
	type CatalogRow,
	listCatalogs,
	makeCatalog,
} from "#/server/purchasing";

type Catalog = NonNullable<ProductRow["catalog"]>;

// A product moving into a catalog, from the one it's in now.
export type Move = { product: ProductRow; from: Catalog };

// Products in another catalog now, which adding them to `to` takes out of
// it. Ones in no catalog, or in `to` already, aren't moves.
export function movesInto(picked: ProductRow[], to: { id: number }): Move[] {
	return picked.flatMap((product) =>
		product.catalog && product.catalog.id !== to.id
			? [{ product, from: product.catalog }]
			: [],
	);
}

// Picks a catalog for the ticked products, or names a new one. When some
// are in another catalog already, a dialog lists them first: moving one
// changes who sells it, which a glance at the button doesn't say.
export function AddToCatalog({
	picked,
	disabled,
	busy,
	onAdd,
	trigger,
}: {
	picked: ProductRow[];
	disabled: boolean;
	busy: boolean;
	onAdd: (catalog: Catalog) => void;
	trigger: (props: { disabled: boolean; busy: boolean }) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [catalogs, setCatalogs] = useState<CatalogRow[] | null>(null);
	const [confirming, setConfirming] = useState<{
		to: Catalog;
		moves: Move[];
	} | null>(null);
	const typed = text.trim();
	const exists = catalogs?.some(
		(c) => c.name.toLowerCase() === typed.toLowerCase(),
	);

	function choose(to: Catalog) {
		setOpen(false);
		setText("");
		const moves = movesInto(picked, to);
		if (moves.length > 0) setConfirming({ to, moves });
		else onAdd(to);
	}

	async function make(name: string) {
		setOpen(false);
		setText("");
		const r = await optimism.change({
			send: () => makeCatalog({ data: { name } }),
		});
		if (!r) return;
		// Seen next time it opens.
		setCatalogs(null);
		choose({ id: r.value, name, photoId: null });
	}

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (next && catalogs === null) listCatalogs().then(setCatalogs);
				}}
			>
				<PopoverTrigger asChild>{trigger({ disabled, busy })}</PopoverTrigger>
				<PopoverContent side="top" className="w-80 p-0">
					<Command>
						<CommandInput
							placeholder="Find or name a catalog"
							value={text}
							onValueChange={setText}
						/>
						<CommandList>
							<CommandEmpty>
								{catalogs === null ? "Loading…" : "No catalog by that name"}
							</CommandEmpty>
							{typed !== "" && catalogs !== null && !exists && (
								<CommandGroup>
									<CommandItem
										value={`new ${typed}`}
										onSelect={() => make(typed)}
									>
										<Plus />
										New catalog "{typed}"
									</CommandItem>
								</CommandGroup>
							)}
							<CommandGroup>
								{catalogs?.map((c) => (
									<CommandItem
										key={c.id}
										value={c.name}
										keywords={c.description ? [c.description] : undefined}
										onSelect={() =>
											choose({ id: c.id, name: c.name, photoId: c.photoId })
										}
									>
										<CatalogOption c={c} />
										<span className="text-xs text-muted-foreground tabular-nums">
											{formatCount(c.products)}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			{confirming && (
				<ConfirmMoves
					to={confirming.to}
					moves={confirming.moves}
					joining={picked.filter((p) => p.catalog === null).length}
					onCancel={() => setConfirming(null)}
					onConfirm={() => {
						setConfirming(null);
						onAdd(confirming.to);
					}}
				/>
			)}
		</>
	);
}

// The products leaving another catalog, grouped by where they're from.
function ConfirmMoves({
	to,
	moves,
	joining,
	onCancel,
	onConfirm,
}: {
	to: Catalog;
	moves: Move[];
	// Ticked products in no catalog, which simply join.
	joining: number;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const groups = new Map<number, { from: Catalog; products: ProductRow[] }>();
	for (const m of moves) {
		const g = groups.get(m.from.id) ?? { from: m.from, products: [] };
		g.products.push(m.product);
		groups.set(m.from.id, g);
	}
	return (
		<Dialog open onOpenChange={(o) => !o && onCancel()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Library className="size-5 text-muted-foreground" />
						Move {formatCount(moves.length)} into {to.name}?
					</DialogTitle>
					<DialogDescription>
						They leave their catalog, so its suppliers stop selling them.
						{joining > 0 &&
							` ${formatCount(joining)} more join from no catalog.`}
					</DialogDescription>
				</DialogHeader>
				<div className="-mx-6 max-h-80 overflow-y-auto border-y px-6 py-2">
					{[...groups.values()].map((g) => (
						<section key={g.from.id} className="py-2">
							<h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
								<CatalogMark catalog={g.from} size="xs" />
								{g.from.name}
								<ArrowRight className="size-3.5 text-muted-foreground" />
								<CatalogMark catalog={to} size="xs" />
								{to.name}
								<span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
									{formatCount(g.products.length)}
								</span>
							</h3>
							<ul className="flex flex-col gap-1">
								{g.products.map((p) => (
									<li key={p.id} className="flex items-center gap-2 text-sm">
										<ProductImage src={p.imageUrl} className="size-7" />
										<span className="min-w-0 flex-1 truncate">
											{p.variantName ? `${p.name} ${p.variantName}` : p.name}
										</span>
										<span className="text-xs text-muted-foreground">
											{p.sku}
										</span>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
				<DialogFooter>
					<Button variant="ghost" size="sm" onClick={onCancel}>
						Cancel
					</Button>
					<Button size="sm" onClick={onConfirm} autoFocus>
						Move {formatCount(moves.length)}
						{joining > 0 && `, add ${formatCount(joining)}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
