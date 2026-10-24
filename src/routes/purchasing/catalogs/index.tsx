import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	ExternalLink,
	FileText,
	Library,
	Plus,
	SearchX,
	Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { CatalogMark } from "#/components/catalog-mark";
import { NewCatalogDialog } from "#/components/catalogs/new-catalog";
import { FilterBar, useSearchRows } from "#/components/filter-bar";
import { Card, EmptyState, Page } from "#/components/page";
import { ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { type Chip, defineSearch } from "#/lib/facet-search";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { offerUndo } from "#/lib/undo";
import { NUMBER, type Sort, TEXT } from "#/products/sort";
import {
	type CatalogRow,
	deleteCatalog,
	listCatalogs,
	restoreCatalog,
} from "#/server/purchasing";

export const Route = createFileRoute("/purchasing/catalogs/")({
	loader: () => listCatalogs(),
	component: Catalogs,
	pendingComponent: () => (
		<ListSkeleton
			title="Catalogs"
			back={{ to: "/purchasing" }}
			width="narrow"
		/>
	),
});

// Every catalog, with changes not yet confirmed laid over them.
export const catalogRows = optimistic<CatalogRow[]>("catalogs");

// What a search matches a catalog on: its name, what it's about, and who
// carries it.
const catalogSearch = defineSearch<CatalogRow, "supplier" | "state">({
	fields: {
		supplier: {
			kind: "values",
			sigil: "&",
			label: "carried by",
			menu: "Supplier",
			words: ["supplier", "carried"],
			of: (c) => c.suppliers.map((s) => s.name),
		},
		state: {
			kind: "values",
			sigil: "%",
			label: "status",
			menu: "Status",
			words: ["status"],
			of: (c) => [
				c.suppliers.length === 0 ? "no supplier" : null,
				c.products === 0 ? "empty" : null,
			],
			known: ["no supplier", "empty"],
			details: new Map([
				["no supplier", "Nobody carries it, so nothing in it is reordered"],
				["empty", "No products in it"],
			]),
			closed: true,
		},
	},
	text: (c) => [c.name, c.description, ...c.suppliers.map((s) => s.name)],
});

const SORTS = {
	name: { label: "Name", ...TEXT },
	products: { label: "Products", ...NUMBER },
	suppliers: { label: "Suppliers", ...NUMBER },
} as const;
const sortValuesOf = (c: CatalogRow) => ({
	name: c.name,
	products: c.products,
	suppliers: c.suppliers.length,
});

function Catalogs() {
	const loaded = Route.useLoaderData();
	const catalogs = catalogRows.useData("all", loaded);
	const [query, setQuery] = useState("");
	const [chips, setChips] = useState<Chip<"supplier" | "state">[]>([]);
	const [sort, setSort] = useState<Sort<keyof typeof SORTS>>([]);
	const [making, setMaking] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const { idx, shown, filtering } = useSearchRows(
		catalogSearch,
		catalogs,
		chips,
		query,
		{ sort, columns: SORTS, values: sortValuesOf },
	);
	useHotkeys({
		n: () => setMaking(true),
		"/": (e) => {
			e.preventDefault();
			input.current?.focus();
		},
	});

	return (
		<Page
			title="Catalogs"
			back={{ to: "/purchasing" }}
			width="narrow"
			actions={
				<Button size="sm" onClick={() => setMaking(true)}>
					<Plus />
					New catalog
				</Button>
			}
		>
			<Card flush className="overflow-visible">
				<FilterBar
					search={catalogSearch}
					idx={idx}
					inputRef={input}
					text={query}
					onText={setQuery}
					chips={chips}
					onChips={setChips}
					sorting={{ sort, onSort: setSort, columns: SORTS }}
					placeholder="Search, or &supplier %empty ^products"
					className="border-b p-2"
				/>
				{filtering && (
					<p className="border-b px-4 py-1.5 text-xs text-muted-foreground tabular-nums">
						{formatCount(shown.length)} of {formatCount(catalogs.length)}
					</p>
				)}
				{catalogs.length === 0 ? (
					<EmptyState icon={Library} title="No catalogs yet">
						A catalog is a line of products, like a brand. Suppliers carry whole
						catalogs.
					</EmptyState>
				) : shown.length === 0 ? (
					<EmptyState icon={SearchX} title="No catalog matches" />
				) : (
					<table className="w-full">
						<tbody>
							{shown.map((c) => (
								<CatalogLine key={c.id} catalog={c} />
							))}
						</tbody>
					</table>
				)}
			</Card>
			<NewCatalogDialog open={making} onOpenChange={setMaking} />
		</Page>
	);
}

function CatalogLine({ catalog: c }: { catalog: CatalogRow }) {
	const { link } = useRowLink();
	const navigate = useNavigate();
	const to = {
		to: "/purchasing/catalogs/$id",
		params: { id: String(c.id) },
	} as const;
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<tr
					{...link(to)}
					className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
				>
					<td className="w-14 py-2.5 pl-4">
						<CatalogMark catalog={c} size="md" />
					</td>
					<td className="w-full max-w-0 px-3 py-2.5">
						<div className="truncate font-medium">{c.name}</div>
						<div className="truncate text-xs text-muted-foreground">
							{c.description ?? (
								<span className="text-faint">No description</span>
							)}
						</div>
					</td>
					<td className="hidden max-w-56 px-3 py-2.5 md:table-cell">
						<div className="truncate text-muted-foreground">
							{c.suppliers.length === 0 ? (
								<span className="text-warning-text">Nobody carries it</span>
							) : (
								c.suppliers.map((s) => s.name).join(", ")
							)}
						</div>
					</td>
					<td className="px-4 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums">
						{formatCount(c.products)}{" "}
						{c.products === 1 ? "product" : "products"}
					</td>
				</tr>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onSelect={() => navigate(to)} shortcut="↵">
					<FileText />
					Open
				</ContextMenuItem>
				<ContextMenuItem
					onSelect={() => window.open(`/purchasing/catalogs/${c.id}`, "_blank")}
				>
					<ExternalLink />
					Open in new tab
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					disabled={c.products > 0}
					onSelect={() => removeCatalog(c)}
					className="text-critical-text [&_svg]:text-critical-text"
				>
					<Trash2 />
					{c.products > 0
						? `Move its ${formatCount(c.products)} out to delete`
						: "Delete"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// Deletes an empty catalog at once, with Undo making it again, carried by
// the same suppliers.
export async function removeCatalog(c: CatalogRow) {
	const r = await optimism.change({
		label: `Deleting ${c.name}`,
		patch: catalogRows.patch("all", (all) => all.filter((x) => x.id !== c.id)),
		send: () => deleteCatalog({ data: { id: c.id } }),
	});
	if (!r) return;
	offerUndo(`Deleted ${c.name}`, {
		undo: async () => {
			const back = await optimism.change({
				label: `Restoring ${c.name}`,
				patch: catalogRows.patch("all", (all) =>
					[...all, c].sort((a, b) => a.name.localeCompare(b.name)),
				),
				send: () => restoreCatalog({ data: r.value }),
			});
			return back && `Restored ${c.name}`;
		},
	});
}
