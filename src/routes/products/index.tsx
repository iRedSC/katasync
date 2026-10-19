import {
	createFileRoute,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
import { type } from "arktype";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FacetRail } from "#/components/facet-rail";
import { AddFilter, SortMenu } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { Card, Page } from "#/components/page";
import { LayoutToggle } from "#/components/products-list/layout-toggle";
import {
	loadPage,
	patchProduct,
	patchViews,
	productsData,
} from "#/components/products-list/optimistic";
import { ProductResults } from "#/components/products-list/product-results";
import { RAIL } from "#/components/products-list/rail";
import { ViewDialog } from "#/components/products-list/view-dialog";
import { Tab } from "#/components/products-list/view-tab";
import { Bone, ListSkeleton } from "#/components/skeleton";
import { Button } from "#/components/ui/button";
import { formatCount, formatOrderQuantity } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { productLanguage } from "#/products/language";
import { facetsOf, sortValuesOf, stateOf } from "#/products/rows";
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
	const language = useMemo(() => productLanguage(facetValues), [facetValues]);
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
									language={language}
									sort={sort}
									onSort={(s) => setSearch({ sort: s })}
									columns={PRODUCT_SORTS}
									placeholder="Search, or #tag @type %status *class >=3 ^sort"
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
					<ProductResults
						layout={search.layout}
						products={filtered.slice(0, shown)}
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
