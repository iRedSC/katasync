import {
	createFileRoute,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
import { type } from "arktype";
import {
	ClipboardList,
	Copy,
	ExternalLink,
	FileText,
	LayoutGrid,
	PackagePlus,
	Pencil,
	Rows3,
	Truck,
} from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FacetRail, type RailGroup } from "#/components/facet-rail";
import { AddFilter, SortMenu } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { AbcBadge, Badge, Card, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Bone, ListSkeleton } from "#/components/skeleton";
import { StockCard } from "#/components/stock-card";
import { Button } from "#/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { VelocityGauge } from "#/components/velocity-gauge";
import { copyText } from "#/lib/copy";
import { formatCount, formatOrderQuantity } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism, optimistic, type Patch } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { facetsOf, sortValuesOf, stateOf, stock } from "#/products/rows";
import {
	type Filter,
	facetCounts,
	type ListField,
	matches,
	parseQuery,
} from "#/products/search";
import { isColumn, sortRows, withTerm } from "#/products/sort";
import {
	filtersType,
	PRODUCT_SORTS,
	type ProductSort,
	parseProductSort,
	type SortText,
	sameSearch,
	sortType,
	spellProductSort,
	type View,
} from "#/products/views";
import {
	cancelCountRequest,
	listProducts,
	type ProductRow,
	requestCount,
} from "#/server/catalog";
import {
	addToPurchaseOrder,
	undoAddToPurchaseOrder,
} from "#/server/purchasing";
import { deleteView, listViews, saveView } from "#/server/views";

// What the page loads. The optimistic patches below lay changes over it until
// the reload shows them.
const loadPage = async () => {
	const [products, views] = await Promise.all([listProducts(), listViews()]);
	return { ...products, views };
};
type ProductsPage = Awaited<ReturnType<typeof loadPage>>;
const productsData = optimistic<ProductsPage>("products");

// A change to one product's row on the list.
function patchProduct(
	productId: number,
	change: (p: ProductRow) => ProductRow,
): Patch {
	return productsData.patch("all", (d) => ({
		...d,
		products: d.products.map((p) => (p.id === productId ? change(p) : p)),
	}));
}

// A change to the saved views, which the tabs and the Save buttons show.
function patchViews(change: (views: View[]) => View[]): Patch {
	return productsData.patch("all", (d) => ({ ...d, views: change(d.views) }));
}

// The URL holds the chips and sort, so links (like Home's "Oversold") and the
// back button work. `view` is the saved view they came from, so it can be
// updated. Anything malformed is dropped rather than failing the page.
// layout is "table" for the old rows; cards are the default. `q` is the
// typed search, so opening a product and coming back keeps it.
type Search = {
	view?: number;
	filters?: Filter[];
	sort?: SortText;
	q?: string;
	layout?: "table";
};

export const Route = createFileRoute("/products/")({
	validateSearch: (search: Record<string, unknown>): Search => {
		const filters = filtersType(search.filters);
		const sort = sortType(String(search.sort ?? ""));
		return {
			view:
				typeof search.view === "number" && search.view > 0
					? search.view
					: undefined,
			filters:
				filters instanceof type.errors || filters.length === 0
					? undefined
					: filters,
			sort: sort instanceof type.errors || sort === "" ? undefined : sort,
			// The URL parser turns "?q=12" into a number, so take it back.
			q:
				(typeof search.q === "string" || typeof search.q === "number") &&
				String(search.q) !== ""
					? String(search.q)
					: undefined,
			layout: search.layout === "table" ? "table" : undefined,
		};
	},
	loader: loadPage,
	component: Products,
	pendingComponent: () => (
		<ListSkeleton title="Products" width="wide">
			<div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
				{Array.from({ length: 12 }, (_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
					<Bone key={i} className="h-44 rounded-xl" />
				))}
			</div>
		</ListSkeleton>
	),
});

const PAGE = 100;

// The rail's groups, in the order a reorder pass goes: what's wrong, whether
// the number can be trusted, whether it's worth it, then who sells it.
const RAIL: RailGroup[] = [
	{
		title: "Stock",
		field: "status",
		values: [
			"needs ordering",
			"below min",
			"oversold",
			"sold out",
			"missing parts",
			"over max",
			"on order",
			"on a draft",
		],
	},
	{
		title: "Trust",
		field: "trust",
		values: ["counted", "uncounted"],
	},
	{
		title: "Class",
		field: "class",
		values: ["A", "B", "C"],
		label: (v) => `${v} items`,
	},
	{ title: "Velocity", field: "velocity", range: true },
	{ title: "Supplier", field: "supplier", values: null },
	{ title: "Type", field: "type", values: null },
];

// Each history entry gets a fresh list, so back and forward bring back that
// entry's search text. Typing replaces the entry, so it doesn't remount.
function Products() {
	const entry = useLocation({ select: (l) => l.state.__TSR_index });
	return <ProductList key={entry} />;
}

function ProductList() {
	const loaded = Route.useLoaderData();
	const { products, views } = productsData.useData("all", loaded);
	const search = Route.useSearch();
	// The router hands back a new array on every render, so key it by content:
	// otherwise each render would count as a change, resetting the selection
	// and scrolling back to the top.
	const filtersKey = JSON.stringify(search.filters ?? []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content on purpose
	const filters = useMemo(() => search.filters ?? [], [filtersKey]);
	const sortText = search.sort ?? spellProductSort([]);
	const sort = useMemo(() => parseProductSort(sortText), [sortText]);
	const current = { filters, sort: sortText };
	const navigate = useNavigate({ from: Route.fullPath });
	const input = useRef<HTMLInputElement>(null);
	// The box answers keystrokes from here; the URL keeps a copy for when the
	// user comes back to this entry.
	const [query, setText] = useState(search.q ?? "");
	function setQuery(text: string) {
		setText(text);
		navigate({
			to: "/products",
			search: (prev) => ({ ...prev, q: text || undefined }),
			replace: true,
			resetScroll: false,
		});
	}
	const [shown, setShown] = useState(PAGE);
	// The product the right-click menu acts on.
	const [menuFor, setMenuFor] = useState<ProductRow | null>(null);
	const [editing, setEditing] = useState<"new" | View | null>(null);
	// Products whose add to a PO is on its way. Not patched, since the PO it
	// lands on comes from the server, so the Add waits for it.
	const [adding, setAdding] = useState<ReadonlySet<number>>(() => new Set());

	// The tab to highlight: the view these came from, else any view that
	// matches exactly, else All when nothing is filtered.
	const plain = filters.length === 0 && sort.length === 0;
	const fromView = views.find((v) => v.id === search.view);
	const active =
		fromView ?? (plain ? undefined : views.find((v) => sameSearch(v, current)));
	const changed = active ? !sameSearch(active, current) : !plain;

	// When this load's trust and counts were worked out against.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new load is a new now
	const now = useMemo(() => new Date(), [loaded]);
	const state = useMemo(
		() => new Map(products.map((p) => [p.id, stateOf(p, now)])),
		[products, now],
	);
	const stateFor = (p: ProductRow) => {
		const s = state.get(p.id);
		// Built from the same products list, so every product has one.
		if (!s) throw new Error(`No stock state for ${p.sku}`);
		return s;
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: state is built from products
	const facets = useMemo(
		() => products.map((p) => facetsOf(p, stateFor(p))),
		[state],
	);
	const facetValues = useMemo(() => facetCounts(facets), [facets]);
	const counts = useMemo(
		() =>
			new Map(
				views.map((v) => [
					v.id,
					facets.filter((f) => matches(f, v.filters, [])).length,
				]),
			),
		[views, facets],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: stateFor reads state
	const filtered = useMemo(() => {
		const q = parseQuery(query);
		const all = [...filters, ...q.filters];
		// A sort still being typed applies once it names a column exactly.
		const by = q.sorts.reduce<ProductSort>(
			(s, t) =>
				isColumn(t.value, PRODUCT_SORTS)
					? withTerm(s, { key: t.value, desc: t.desc })
					: s,
			sort,
		);
		return sortRows(
			products.filter((_, i) => matches(facets[i], all, q.words)),
			by,
			(p) => sortValuesOf(p, stateFor(p)),
		);
	}, [products, facets, query, filters, sort, state]);
	// For each rail group, how many products each value would show given
	// everything else picked, so a count never promises an empty list.
	const railCounts = useMemo(() => {
		const q = parseQuery(query);
		const all = [...filters, ...q.filters];
		const out = new Map<ListField, Map<string, number>>();
		for (const g of RAIL) {
			if ("range" in g) continue;
			const { field } = g;
			const others = all.filter((f) => f.field !== field);
			const values = new Map<string, number>();
			for (const f of facets) {
				if (!matches(f, others, q.words)) continue;
				for (const v of new Set(f[field]))
					values.set(v, (values.get(v) ?? 0) + 1);
			}
			out.set(field, values);
		}
		return out;
	}, [facets, query, filters]);

	const { link } = useRowLink();
	const to = (p: ProductRow) =>
		({ to: "/products/$sku", params: { sku: p.sku } }) as const;
	const open = (p: ProductRow) => navigate(to(p));

	// Chip and sort changes replace the history entry instead of piling up.
	function setSearch(next: Partial<{ filters: Filter[]; sort: ProductSort }>) {
		setShown(PAGE);
		const { sort: by, ...rest } = next;
		navigate({
			to: "/products",
			search: (prev) => ({
				...prev,
				...rest,
				...(by ? { sort: spellProductSort(by) || undefined } : {}),
			}),
			replace: true,
		});
	}
	// A new entry, so the list remounts with an empty search box.
	function showView(v: View | null) {
		navigate({
			to: "/products",
			search: {
				...(v
					? { view: v.id, filters: v.filters, sort: v.sort || undefined }
					: {}),
				layout: search.layout,
			},
		});
	}

	useHotkeys({
		"/": () => input.current?.focus(),
		Escape: () => {
			if (document.activeElement === input.current) input.current?.blur();
			else if (query) setQuery("");
		},
	});

	return (
		<Page
			title="Products"
			width="wide"
			actions={
				<LayoutToggle
					layout={search.layout ?? "cards"}
					onLayout={(l) =>
						navigate({
							to: "/products",
							search: (prev) => ({
								...prev,
								layout: l === "table" ? "table" : undefined,
							}),
							replace: true,
						})
					}
				/>
			}
		>
			<div className="flex items-start gap-6">
				{/* Scrolls on its own, held under the app bar while the list scrolls. */}
				<aside className="sticky top-[4.5rem] hidden max-h-[calc(100svh-5.5rem)] w-56 shrink-0 overflow-y-auto overscroll-contain pb-4 lg:block">
					<FacetRail
						groups={RAIL}
						counts={railCounts}
						filters={filters}
						onFilters={(next) => setSearch({ filters: next })}
					/>
				</aside>
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<Card flush className="overflow-visible">
						<div className="flex flex-wrap items-center gap-1 border-b p-2">
							<Tab
								label="All"
								count={products.length}
								active={!active && plain}
								onClick={() => showView(null)}
							/>
							{views.map((v) => (
								<Tab
									key={v.id}
									label={v.name}
									count={counts.get(v.id) ?? 0}
									active={active?.id === v.id}
									changed={active?.id === v.id && changed}
									onClick={() => showView(v)}
									onEdit={
										active?.id === v.id && !changed
											? () => setEditing(v)
											: undefined
									}
								/>
							))}
							{changed && (
								<div className="ml-auto flex gap-1">
									{active && (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => showView(active)}
										>
											Undo changes
										</Button>
									)}
									{active && (
										<Button
											size="sm"
											variant="outline"
											onClick={() => updateView(active)}
										>
											Save
										</Button>
									)}
									<Button size="sm" onClick={() => setEditing("new")}>
										{active ? "Save as new view" : "Save view"}
									</Button>
								</div>
							)}
						</div>
						<div className="flex items-start gap-1 border-b p-2">
							<div className="min-w-0 flex-1">
								<FilterSearch
									inputRef={input}
									text={query}
									onText={(text) => {
										setQuery(text);
										setShown(PAGE);
									}}
									chips={filters}
									onChips={(next) => setSearch({ filters: next })}
									counts={facetValues}
									sort={sort}
									onSort={(s) => setSearch({ sort: s })}
									columns={PRODUCT_SORTS}
									placeholder="Search, filter (#tag @type %status *class >=3), or sort (^cost ^!velocity)"
								/>
							</div>
							<AddFilter
								counts={facetValues}
								onAdd={(f) => setSearch({ filters: [...filters, f] })}
							/>
							<SortMenu
								sort={sort}
								onSort={(s) => setSearch({ sort: s })}
								columns={PRODUCT_SORTS}
							/>
						</div>
					</Card>
					{search.layout === "table" ? (
						<Card flush>
							<table className="w-full">
								<thead>
									<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
										<th className="px-4 py-2 font-medium">Product</th>
										<th className="px-2 py-2 text-center font-medium">Class</th>
										<th className="hidden px-4 py-2 font-medium md:table-cell">
											Status
										</th>
										<th className="px-4 py-2 font-medium">Inventory</th>
										<th className="hidden px-4 py-2 text-right font-medium xl:table-cell">
											On order
										</th>
										<th
											className="hidden px-2 py-2 text-center font-medium md:table-cell"
											title="Units sold a month. Hover for the reorder math"
										>
											Velocity
										</th>
										<th className="hidden px-4 py-2 font-medium md:table-cell">
											Reorder
										</th>
										<th className="hidden px-4 py-2 font-medium 2xl:table-cell">
											Type
										</th>
									</tr>
								</thead>
								{/* One menu for the whole list: it acts on the row that was
					    right-clicked. */}
								<ContextMenu>
									<ContextMenuTrigger asChild>
										<tbody>
											{filtered.slice(0, shown).map((p) => (
												<tr
													key={p.id}
													{...link(to(p))}
													onContextMenu={() => setMenuFor(p)}
													className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
												>
													{/* Takes the width the other columns leave, so long names end
								    in "…" instead of pushing them off the card. */}
													<td className="w-full max-w-0 px-4 py-2">
														<div className="flex items-center gap-3">
															<ProductImage src={p.imageUrl} />
															<div className="min-w-0 flex-1">
																<ProductName
																	name={p.name}
																	variantName={p.variantName}
																/>
																<div className="flex gap-2 text-xs text-muted-foreground">
																	<span>{p.sku}</span>
																	{p.kind === "bundle" && <span>Tool set</span>}
																	{p.kind === "kit" && <span>Kit</span>}
																</div>
															</div>
														</div>
													</td>
													<td className="px-2 py-2 text-center">
														<AbcBadge
															abc={p.abc}
															title={
																p.abcRank === null
																	? "Needs a cost to get a class"
																	: p.kind === "bundle"
																		? `#${formatCount(p.abcRank)} of tool sets by value`
																		: `#${formatCount(p.abcRank)} by value`
															}
														/>
													</td>
													<td className="hidden px-4 py-2 whitespace-nowrap md:table-cell">
														<RowStatus product={p} />
													</td>
													<td className="px-4 py-2 whitespace-nowrap">
														<Inventory product={p} />
													</td>
													<td className="hidden px-4 py-2 text-right whitespace-nowrap tabular-nums xl:table-cell">
														{p.onOrder > 0 ? formatCount(p.onOrder) : ""}
													</td>
													<td className="hidden px-2 py-1.5 md:table-cell">
														<VelocityGauge
															why={p.why}
															onPo={p.draft ?? undefined}
														/>
													</td>
													<td className="hidden px-4 py-2 whitespace-nowrap md:table-cell">
														<Reorder product={p} />
													</td>
													<td className="hidden px-4 py-2 whitespace-nowrap text-muted-foreground 2xl:table-cell">
														{p.category ?? ""}
													</td>
												</tr>
											))}
										</tbody>
									</ContextMenuTrigger>
									{menuFor && (
										<RowMenu
											product={menuFor}
											onOpen={open}
											onAddToPo={addToPo}
											adding={adding}
											onCount={countStock}
										/>
									)}
								</ContextMenu>
							</table>
						</Card>
					) : (
						<ContextMenu>
							<ContextMenuTrigger asChild>
								<div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
									{filtered.slice(0, shown).map((p) => (
										<StockCard
											key={p.id}
											product={p}
											state={stateFor(p)}
											now={now}
											link={link(to(p))}
											onMenu={() => setMenuFor(p)}
											busy={adding.has(p.id)}
											onOrder={() => addToPo(p)}
											onCount={() => countStock(p)}
										/>
									))}
								</div>
							</ContextMenuTrigger>
							{menuFor && (
								<RowMenu
									product={menuFor}
									onOpen={open}
									onAddToPo={addToPo}
									adding={adding}
									onCount={countStock}
								/>
							)}
						</ContextMenu>
					)}
					{filtered.length === 0 && (
						<p className="rounded-xl bg-card py-16 text-center text-muted-foreground shadow-card">
							No products match. Try a shorter search, or untick a filter.
						</p>
					)}
					{shown < filtered.length && (
						<div className="flex justify-center">
							<Button
								variant="outline"
								onClick={() => setShown((n) => n + PAGE)}
							>
								Show {formatCount(Math.min(PAGE, filtered.length - shown))} more
							</Button>
						</div>
					)}
				</div>
			</div>

			{editing && (
				<ViewDialog
					key={editing === "new" ? "new" : editing.id}
					view={editing === "new" ? null : editing}
					search={current}
					onClose={() => setEditing(null)}
					onSaved={(id) => {
						setEditing(null);
						navigate({
							to: "/products",
							search: (prev) => ({ ...prev, view: id, ...current }),
						});
					}}
					onDeleted={() => {
						setEditing(null);
						showView(null);
					}}
				/>
			)}
		</Page>
	);

	async function addToPo(p: ProductRow) {
		setAdding((ids) => new Set(ids).add(p.id));
		// Not patched: the PO it lands on comes from the server, and may be a new draft.
		const r = await optimism.change({
			send: () =>
				addToPurchaseOrder({
					data: { productId: p.id, quantity: p.reorder?.quantity },
				}),
		});
		setAdding((ids) => new Set([...ids].filter((id) => id !== p.id)));
		if (!r) return;
		const { added, purchaseOrderId, supplierName, line } = r.value;
		if (!added) {
			toast(
				`${p.sku} is already on PO ${purchaseOrderId}: ${formatOrderQuantity(line)}`,
			);
			return;
		}
		offerUndo(
			`Added ${formatOrderQuantity(line)} to PO ${purchaseOrderId} (${supplierName})`,
			{
				tone: "success",
				undo: async () => {
					const undone = await optimism.change({
						label: `Taking ${p.sku} off PO ${purchaseOrderId}`,
						patch: patchProduct(p.id, (x) => ({ ...x, draft: null })),
						send: () =>
							undoAddToPurchaseOrder({ data: { purchaseOrderId, line } }),
					});
					return (
						undone &&
						(undone.value
							? `Took ${p.sku} off PO ${purchaseOrderId}`
							: `${p.sku} on PO ${purchaseOrderId} changed since, so it's left as is`)
					);
				},
			},
		);
	}

	async function countStock(p: ProductRow) {
		const r = await optimism.change({
			label: `Count request for ${p.sku}`,
			patch: patchProduct(p.id, (x) => ({ ...x, countRequested: true })),
			send: () => requestCount({ data: { productId: p.id } }),
		});
		if (!r) return;
		const added = r.value;
		if (added.length === 0) {
			toast(`${p.sku} is already on the count list`);
			return;
		}
		offerUndo(`Added ${p.sku} to the count list`, {
			tone: "success",
			undo: async () => {
				const cancelled = await optimism.change({
					label: `Taking ${p.sku} off the count list`,
					patch: patchProduct(p.id, (x) => ({ ...x, countRequested: false })),
					send: () => cancelCountRequest({ data: { requests: added } }),
				});
				return (
					cancelled &&
					(cancelled.value < added.length
						? `${p.sku}'s count request changed since, so it's left as is`
						: `Took ${p.sku} off the count list`)
				);
			},
		});
	}

	async function updateView(v: View) {
		const r = await optimism.change({
			label: `Saving “${v.name}”`,
			patch: patchViews((views) =>
				views.map((x) => (x.id === v.id ? { ...x, ...current } : x)),
			),
			send: () => saveView({ data: { id: v.id, name: v.name, ...current } }),
		});
		if (!r) return;
		offerUndo(`Saved “${v.name}”`, {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					label: `Putting “${v.name}” back`,
					patch: patchViews((views) =>
						views.map((x) => (x.id === v.id ? v : x)),
					),
					send: () => saveView({ data: v }),
				});
				return back && `“${v.name}” back as it was`;
			},
		});
	}
}

function Tab({
	label,
	count,
	active,
	changed = false,
	onClick,
	onEdit,
}: {
	label: string;
	count: number;
	active: boolean;
	changed?: boolean;
	onClick: () => void;
	onEdit?: () => void;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-7 items-center rounded-lg font-medium",
				active
					? "bg-surface-strong text-foreground"
					: "text-muted-foreground hover:bg-surface hover:text-foreground",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				className="inline-flex h-full items-center gap-1.5 px-2.5"
			>
				{label}
				{changed ? (
					<span className="text-xs text-muted-foreground">edited</span>
				) : (
					<span className="tabular-nums text-muted-foreground">
						{formatCount(count)}
					</span>
				)}
			</button>
			{onEdit && (
				<button
					type="button"
					onClick={onEdit}
					aria-label={`Rename or delete ${label}`}
					className="-ml-1.5 mr-1 rounded p-1 text-muted-foreground hover:bg-line hover:text-foreground"
				>
					<Pencil className="size-3" />
				</button>
			)}
		</span>
	);
}

// Names a new view, or renames or deletes an existing one.
function ViewDialog({
	view,
	search,
	onClose,
	onSaved,
	onDeleted,
}: {
	view: View | null;
	search: { filters: Filter[]; sort: SortText };
	onClose: () => void;
	onSaved: (id: number) => void;
	onDeleted: () => void;
}) {
	const [name, setName] = useState(view?.name ?? "");
	const [saving, setSaving] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (view) {
			// A rename shows at once, so the dialog closes as it's made. If it
			// fails, the engine says why and the old name comes back.
			const { id } = view;
			const next = { ...view, name };
			void optimism.change({
				label: `Renaming “${view.name}”`,
				patch: patchViews((views) =>
					views.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)),
				),
				send: () => saveView({ data: next }),
			});
			onSaved(id);
			return;
		}
		// A new view's id comes from the server, so the dialog waits for it.
		setSaving(true);
		const r = await optimism.change({
			send: () => saveView({ data: { name, ...search } }),
		});
		setSaving(false);
		if (r) onSaved(r.value.id);
	}

	function remove() {
		if (!view) return;
		const gone = view;
		// Off the tabs at once. Undo brings it back as a new view, since the
		// server gives it a new id.
		void optimism
			.change({
				label: `Deleting “${gone.name}”`,
				patch: patchViews((views) => views.filter((v) => v.id !== gone.id)),
				send: () => deleteView({ data: { id: gone.id } }),
			})
			.then((r) => {
				if (!r) return;
				offerUndo(`Deleted “${gone.name}”`, {
					undo: async () => {
						const { id: _, ...rest } = gone;
						const back = await optimism.change({
							send: () => saveView({ data: rest }),
						});
						return back && `“${gone.name}” is back`;
					},
				});
			});
		onDeleted();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-sm">
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{view ? "Edit view" : "Save view"}</DialogTitle>
					</DialogHeader>
					<input
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Name, e.g. Low stock A items"
						className="h-9 rounded-lg border border-input px-3 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
					/>
					<DialogFooter className="sm:justify-between">
						{view ? (
							<Button type="button" variant="ghost" onClick={remove}>
								Delete view
							</Button>
						) : (
							<span />
						)}
						<Button type="submit" disabled={!name.trim() || saving}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// Only problems get a badge. A healthy row stays quiet.
function RowStatus({ product: p }: { product: ProductRow }) {
	if ((p.onHand ?? 0) < 0) return <Badge tone="critical">Oversold</Badge>;
	if (p.kind === "bundle" && p.available === 0) {
		return <Badge tone="warning">Missing parts</Badge>;
	}
	if (p.available === 0) return <Badge>Sold out</Badge>;
	return null;
}

function Inventory({ product: p }: { product: ProductRow }) {
	if ((p.onHand ?? 0) < 0) {
		return (
			<span className="font-medium text-critical-text">
				{formatCount(stock(p))} in stock
			</span>
		);
	}
	return (
		<span className={cn(p.available === 0 && "text-muted-foreground")}>
			{formatCount(p.available)}{" "}
			{p.kind === "bundle" ? "can be built" : "in stock"}
		</span>
	);
}

// What putting this product on a PO means right now. A tool set's supplier
// is the one most of its parts come from.
function orderAction(p: ProductRow) {
	if (p.draft)
		return {
			kind: "draft" as const,
			why: `Already on PO ${p.draft.purchaseOrderId}`,
		};
	if (!p.supplier)
		return { kind: "no supplier" as const, why: "Set a supplier first" };
	return { kind: "add" as const, why: "", supplier: p.supplier.name };
}

// The suggested order, or the line already waiting on a draft.
function Reorder({ product: p }: { product: ProductRow }) {
	if (p.draft) {
		return (
			<span className="text-muted-foreground">
				{formatOrderQuantity(p.draft)} on PO {p.draft.purchaseOrderId}
			</span>
		);
	}
	if (p.reorder) {
		return (
			<span className="font-medium">{formatOrderQuantity(p.reorder)}</span>
		);
	}
	return null;
}

function RowMenu({
	product: p,
	onOpen,
	onAddToPo,
	adding,
	onCount,
}: {
	product: ProductRow;
	onOpen: (p: ProductRow) => void;
	onAddToPo: (p: ProductRow) => void;
	adding: ReadonlySet<number>;
	onCount: (p: ProductRow) => void;
}) {
	const navigate = useNavigate();
	const action = orderAction(p);
	const url = `/products/${encodeURIComponent(p.sku)}`;

	return (
		<ContextMenuContent>
			<ContextMenuItem onSelect={() => onOpen(p)} shortcut="↵">
				<FileText />
				Open
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => window.open(url, "_blank")}>
				<ExternalLink />
				Open in new tab
			</ContextMenuItem>
			{action && <ContextMenuSeparator />}
			{action?.kind === "add" && (
				<ContextMenuItem
					onSelect={() => onAddToPo(p)}
					disabled={adding.has(p.id)}
					shortcut={p.reorder ? "A" : undefined}
				>
					<PackagePlus />
					{p.reorder
						? `Add ${formatOrderQuantity(p.reorder)} to PO`
						: "Add to PO"}
				</ContextMenuItem>
			)}
			{action?.kind === "draft" && p.draft && (
				<ContextMenuItem
					onSelect={() =>
						navigate({
							to: "/purchasing/$id",
							params: { id: String(p.draft?.purchaseOrderId) },
						})
					}
				>
					<Truck />
					Open PO {p.draft.purchaseOrderId}
				</ContextMenuItem>
			)}
			{action?.kind === "no supplier" && (
				<ContextMenuItem onSelect={() => onOpen(p)}>
					<PackagePlus />
					Set a supplier to order it
				</ContextMenuItem>
			)}
			<ContextMenuItem onSelect={() => onCount(p)} shortcut="C">
				<ClipboardList />
				Count stock
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => copyText(p.sku)}>
				<Copy />
				Copy SKU
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

// Cards for deciding, the table for comparing numbers side by side.
function LayoutToggle({
	layout,
	onLayout,
}: {
	layout: "cards" | "table";
	onLayout: (layout: "cards" | "table") => void;
}) {
	return (
		<fieldset className="flex rounded-lg bg-surface-strong p-0.5">
			<legend className="sr-only">Layout</legend>
			{(
				[
					["cards", LayoutGrid, "Cards"],
					["table", Rows3, "Table"],
				] as const
			).map(([l, Icon, label]) => (
				<button
					key={l}
					type="button"
					aria-pressed={layout === l}
					onClick={() => onLayout(l)}
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium",
						layout === l
							? "bg-card text-foreground shadow-card"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<Icon className="size-3.5" />
					{label}
				</button>
			))}
		</fieldset>
	);
}
