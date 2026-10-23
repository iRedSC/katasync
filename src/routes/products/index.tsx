import {
	createFileRoute,
	Link,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
import { type } from "arktype";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SortMenu } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { Card, Page } from "#/components/page";
import {
	isLens,
	LENSES,
	type LensKey,
} from "#/components/products-list/columns";
import {
	loadPage,
	patchProduct,
	patchViews,
	productsData,
} from "#/components/products-list/optimistic";
import { ProductTable } from "#/components/products-list/product-table";
import { usePinned, useSelection } from "#/components/products-list/selection";
import {
	clearWithUndo,
	SelectionBar,
} from "#/components/products-list/selection-bar";
import { ViewDialog } from "#/components/products-list/view-dialog";
import { Tab } from "#/components/products-list/view-tab";
import { Bone, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatOrderQuantity } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { productLanguage } from "#/products/language";
import { facetsOf, sortValuesOf, stateOf } from "#/products/rows";
import {
	compile,
	type Filter,
	facetCounts,
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
	type ProductRow,
	requestCount,
} from "#/server/catalog";
import {
	addToPurchaseOrder,
	undoAddToPurchaseOrder,
} from "#/server/purchasing";
import { saveView } from "#/server/views";

// The URL holds the chips and sort, so links (like Home's "Oversold") and the
// back button work. `view` is the saved view they came from, so it can be
// updated. Anything malformed is dropped rather than failing the page.
// `lens` picks the table's columns; stock is the default. `q` is the typed
// search, so opening a product and coming back keeps it.
type Search = {
	view?: number;
	filters?: Filter[];
	sort?: SortText;
	q?: string;
	lens?: Exclude<LensKey, "stock">;
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
			lens:
				isLens(search.lens) && search.lens !== "stock"
					? search.lens
					: undefined,
		};
	},
	loader: loadPage,
	component: Products,
	pendingComponent: () => (
		<ListSkeleton title="Products" width="wide">
			<div className="flex flex-col gap-px overflow-hidden rounded-xl">
				{Array.from({ length: 12 }, (_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
					<Bone key={i} className="h-14 rounded-none" />
				))}
			</div>
		</ListSkeleton>
	),
});

const PAGE = 100;

// Each history entry gets a fresh list, so back and forward bring back that
// entry's search text. Typing replaces the entry, so it doesn't remount.
function Products() {
	const entry = useLocation({ select: (l) => l.state.__TSR_index });
	return <ProductList key={entry} />;
}

function ProductList() {
	const loaded = Route.useLoaderData();
	const { products, views, archived } = productsData.useData("all", loaded);
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
	const [editing, setEditing] = useState<"new" | View | null>(null);
	// Products whose add to a PO is on its way. Not patched, since the PO it
	// lands on comes from the server, so the Add waits for it.
	const [adding, setAdding] = useState<ReadonlySet<number>>(() => new Set());
	const lens = search.lens ?? "stock";
	const [selected, setSelected] = useSelection();
	const pinned = usePinned(`${filtersKey}|${query}|${sortText}`, selected);

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
	const language = useMemo(() => productLanguage(facetValues), [facetValues]);
	const counts = useMemo(
		() =>
			new Map(
				views.map((v) => [
					v.id,
					facets.filter(compile(v.filters, []).matches).length,
				]),
			),
		[views, facets],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: stateFor reads state
	const filtered = useMemo(() => {
		const q = parseQuery(query);
		const search = compile([...filters, ...q.filters], q.words);
		// A sort still being typed applies once it names a column exactly.
		const by = q.sorts.reduce<ProductSort>(
			(s, t) =>
				isColumn(t.value, PRODUCT_SORTS)
					? withTerm(s, { key: t.value, desc: t.desc })
					: s,
			sort,
		);
		return sortRows(
			products.filter((_, i) => search.matches(facets[i])),
			by,
			(p) => sortValuesOf(p, stateFor(p)),
		);
	}, [products, facets, query, filters, sort, state]);
	// The pinned group shows while any of it is still ticked, and its rows
	// leave the list below so none shows twice.
	const grouped = products.some((p) => pinned.has(p.id) && selected.has(p.id));
	const pinnedRows = grouped
		? [
				...filtered.filter((p) => pinned.has(p.id)),
				...products.filter((p) => pinned.has(p.id) && !filtered.includes(p)),
			]
		: [];
	const listed = grouped ? filtered.filter((p) => !pinned.has(p.id)) : filtered;
	const picked = products.filter((p) => selected.has(p.id));

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
				lens: search.lens,
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
				<>
					{archived > 0 && (
						<Button variant="ghost" asChild>
							<Link to="/products/archived">
								Archived
								<span className="text-muted-foreground tabular-nums">
									{formatCount(archived)}
								</span>
							</Link>
						</Button>
					)}
					<LensSwitch
						lens={lens}
						onLens={(l) =>
							navigate({
								to: "/products",
								search: (prev) => ({
									...prev,
									lens: l === "stock" ? undefined : l,
								}),
								replace: true,
								resetScroll: false,
							})
						}
					/>
				</>
			}
		>
			<div className="flex flex-col gap-3 pb-16">
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
								language={language}
								sort={sort}
								onSort={(s) => setSearch({ sort: s })}
								columns={PRODUCT_SORTS}
								placeholder="Search, or filter by tag, vendor, status…"
							/>
						</div>
						<SortMenu
							sort={sort}
							onSort={(s) => setSearch({ sort: s })}
							columns={PRODUCT_SORTS}
						/>
					</div>
				</Card>
				<ProductTable
					lens={lens}
					rows={listed.slice(0, shown)}
					matched={filtered}
					pinned={pinnedRows}
					selected={selected}
					onSelected={setSelected}
					sort={sort}
					onSort={(s) => setSearch({ sort: s })}
					stateFor={stateFor}
					now={now}
					adding={adding}
					onAddToPo={addToPo}
					onCount={countStock}
				/>
				{filtered.length === 0 && (
					<p className="rounded-xl bg-card py-16 text-center text-muted-foreground shadow-card">
						No matches.
					</p>
				)}
				{shown < listed.length && (
					<div className="flex justify-center">
						<Button variant="outline" onClick={() => setShown((n) => n + PAGE)}>
							Show {formatCount(Math.min(PAGE, listed.length - shown))} more
						</Button>
					</div>
				)}
			</div>
			<SelectionBar
				picked={picked}
				onClear={() => clearWithUndo(selected, setSelected)}
			/>

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
							: `Can't undo: ${p.sku} on PO ${purchaseOrderId} changed`)
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
						? `Can't undo: ${p.sku}'s count request changed`
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

// Which columns the table shows: one set per job.
function LensSwitch({
	lens,
	onLens,
}: {
	lens: LensKey;
	onLens: (lens: LensKey) => void;
}) {
	return (
		<div className="flex rounded-lg bg-surface-strong p-0.5">
			{(Object.keys(LENSES) as LensKey[]).map((key) => {
				const { label, icon: Icon } = LENSES[key];
				return (
					<Tip key={key} content={label}>
						<button
							type="button"
							aria-pressed={lens === key}
							onClick={() => onLens(key)}
							className={cn(
								"inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors",
								lens === key
									? "bg-white text-foreground shadow-card"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							<Icon className="size-4" />
							<span className="hidden xl:inline">{label}</span>
						</button>
					</Tip>
				);
			})}
		</div>
	);
}
