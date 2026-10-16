import {
	createFileRoute,
	useNavigate,
	useRouter,
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
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FacetRail, type RailGroup } from "#/components/facet-rail";
import { AddFilter, SortMenu } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { AbcBadge, Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { StockCard, type StockState } from "#/components/stock-card";
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
import {
	daysLeft,
	levelOf,
	nextStepOf,
	TRUST_DAYS,
	trustOf,
} from "#/inventory/stock-state";
import { formatCount, formatOrderQuantity } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import {
	type Facets,
	type Filter,
	facetCounts,
	type ListField,
	matches,
	parseQuery,
} from "#/products/search";
import {
	filtersType,
	type Sort,
	sameSearch,
	sortType,
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

// The URL holds the chips and sort, so links (like Home's "Oversold") and the
// back button work. `view` is the saved view they came from, so it can be
// updated. Anything malformed is dropped rather than failing the page.
// layout is "table" for the old rows; cards are the default.
type Search = {
	view?: number;
	filters?: Filter[];
	sort?: Sort;
	layout?: "table";
};

export const Route = createFileRoute("/products/")({
	validateSearch: (search: Record<string, unknown>): Search => {
		const filters = filtersType(search.filters);
		const sort = sortType(search.sort);
		return {
			view:
				typeof search.view === "number" && search.view > 0
					? search.view
					: undefined,
			filters:
				filters instanceof type.errors || filters.length === 0
					? undefined
					: filters,
			sort: sort instanceof type.errors || sort === "name" ? undefined : sort,
			layout: search.layout === "table" ? "table" : undefined,
		};
	},
	loader: async () => {
		const [products, views] = await Promise.all([listProducts(), listViews()]);
		return { ...products, views };
	},
	component: Products,
});

const PAGE = 100;

// The number the Inventory column shows: what's on the shelf when oversold,
// otherwise what can be sold or built.
function stock(p: ProductRow) {
	return (p.onHand ?? 0) < 0 ? (p.onHand ?? 0) : p.available;
}

// Trust, level, and next step, worked out once per product per load.
function stateOf(p: ProductRow, now: Date): StockState {
	const input = {
		...p,
		hasSupplier: p.supplier !== null,
	};
	const trust = trustOf(input, now);
	return {
		trust,
		level: levelOf(input),
		step: nextStepOf(input, trust),
		daysLeft: daysLeft(p.onHand, p.dailyDemand),
	};
}

// What the search language can filter each product on. Status covers
// Shopify's (active, draft, archived), the stock level unless healthy, and
// whether it's a tool set or kit.
function facetsOf(p: ProductRow, state: StockState): Facets {
	const title = p.variantName ? `${p.name} ${p.variantName}` : p.name;
	const status = p.status ? [p.status.toLowerCase()] : [];
	if (state.level !== "healthy") status.push(state.level);
	if (p.kind === "bundle") status.push("tool set");
	if (p.kind === "kit") status.push("kit");
	if (p.reorder) status.push("needs ordering");
	if (p.draft) status.push("on a draft");
	if (p.onOrder > 0) status.push("on order");
	if (!p.supplier && p.kind !== "bundle") status.push("no supplier");
	const trust =
		state.trust === null
			? []
			: state.trust.kind === "counted"
				? ["counted"]
				: state.trust.requested
					? ["needs count", "count requested"]
					: ["needs count"];
	return {
		text: [p.sku, title, p.category ?? ""],
		title: [title],
		tag: p.tags,
		type: p.category ? [p.category] : [],
		vendor: p.vendor ? [p.vendor] : [],
		status,
		class: p.abc ? [p.abc] : [],
		supplier: p.supplier ? [p.supplier.name] : [],
		trust,
		inventory: stock(p),
	};
}

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
		values: ["counted", "needs count", "count requested"],
		label: (v) =>
			v === "counted"
				? `Counted in ${TRUST_DAYS} days`
				: v === "needs count"
					? "Needs a count"
					: "On the count list",
	},
	{
		title: "Class",
		field: "class",
		values: ["A", "B", "C"],
		label: (v) => `${v} items`,
	},
	{ title: "Supplier", field: "supplier", values: null },
	{ title: "Type", field: "type", values: null },
];

// Name order comes from the server; the rest re-sort from it, so ties stay
// in name order.
function sorted(
	products: ProductRow[],
	sort: Sort,
	state: Map<number, StockState>,
) {
	const left = (p: ProductRow) => state.get(p.id)?.daysLeft ?? Infinity;
	const by = {
		name: () => products,
		"-name": () => [...products].reverse(),
		inventory: () => [...products].sort((a, b) => stock(a) - stock(b)),
		"-inventory": () => [...products].sort((a, b) => stock(b) - stock(a)),
		// Unclassed products go last.
		value: () =>
			[...products].sort(
				(a, b) => (a.abcRank ?? Infinity) - (b.abcRank ?? Infinity),
			),
		// Unsold products last, since they aren't running out.
		runout: () => [...products].sort((a, b) => left(a) - left(b)),
	};
	return by[sort]();
}

function Products() {
	const { products, abcDays, unpriced, views } = Route.useLoaderData();
	const search = Route.useSearch();
	// The router hands back a new array on every render, so key it by content:
	// otherwise each render would count as a change, resetting the selection
	// and scrolling back to the top.
	const filtersKey = JSON.stringify(search.filters ?? []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content on purpose
	const filters = useMemo(() => search.filters ?? [], [filtersKey]);
	const sort = search.sort ?? "name";
	const current = { filters, sort };
	const navigate = useNavigate();
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const [shown, setShown] = useState(PAGE);
	const [selected, setSelected] = useState(0);
	const [editing, setEditing] = useState<"new" | View | null>(null);

	// The tab to highlight: the view these came from, else any view that
	// matches exactly, else All when nothing is filtered.
	const plain = filters.length === 0 && sort === "name";
	const fromView = views.find((v) => v.id === search.view);
	const active =
		fromView ?? (plain ? undefined : views.find((v) => sameSearch(v, current)));
	const changed = active ? !sameSearch(active, current) : !plain;

	// When this load's trust and counts were worked out against.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new load is a new now
	const now = useMemo(() => new Date(), [products]);
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
	const filtered = useMemo(() => {
		const q = parseQuery(query);
		const all = [...filters, ...q.filters];
		return sorted(
			products.filter((_, i) => matches(facets[i], all, q.words)),
			sort,
			state,
		);
	}, [products, facets, query, filters, sort, state]);
	// For each rail group, how many products each value would show given
	// everything else picked, so a count never promises an empty list.
	const railCounts = useMemo(() => {
		const q = parseQuery(query);
		const all = [...filters, ...q.filters];
		const out = new Map<ListField, Map<string, number>>();
		for (const { field } of RAIL) {
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the list changes
	useEffect(() => setSelected(0), [query, filters, sort]);
	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${selected}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	const last = Math.min(shown, filtered.length) - 1;
	const open = (p: ProductRow | undefined) =>
		p && navigate({ to: "/products/$sku", params: { sku: p.sku } });

	// Chip and sort changes replace the history entry instead of piling up.
	function setSearch(next: Partial<{ filters: Filter[]; sort: Sort }>) {
		setShown(PAGE);
		navigate({
			to: "/products",
			search: { ...search, ...next },
			replace: true,
		});
	}
	function showView(v: View | null) {
		setQuery("");
		setShown(PAGE);
		navigate({
			to: "/products",
			search: {
				...(v ? { view: v.id, filters: v.filters, sort: v.sort } : {}),
				layout: search.layout,
			},
		});
	}

	useHotkeys({
		"/": () => input.current?.focus(),
		j: () => setSelected((i) => Math.min(i + 1, last)),
		k: () => setSelected((i) => Math.max(i - 1, 0)),
		Enter: () => open(filtered[selected]),
		// Does the card's button: orders what's suggested, once the stock is
		// trusted. Anything else takes the menu, so a stray key press can't
		// start a PO.
		a: () => {
			const p = filtered[selected];
			if (!p) return;
			const step = stateFor(p).step;
			if (step.kind === "order") addToPo(p);
			else if (step.kind === "count")
				toast(
					`Count ${p.sku} first: its stock hasn't been counted in ${TRUST_DAYS} days`,
				);
			else toast(orderAction(p)?.why || `${p.sku} doesn't need ordering`);
		},
		c: () => {
			const p = filtered[selected];
			if (p && p.kind !== "bundle") countStock(p);
		},
		Escape: () => {
			if (document.activeElement === input.current) input.current?.blur();
			else if (query) setQuery("");
		},
	});

	const aboutValue =
		sort === "value" || filters.some((f) => f.field === "class");

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
							search: {
								...search,
								layout: l === "table" ? "table" : undefined,
							},
							replace: true,
						})
					}
				/>
			}
		>
			{aboutValue && unpriced > 0 && (
				<Banner
					tone="warning"
					title={`${formatCount(unpriced)} sold ${unpriced === 1 ? "product needs a cost" : "products need a cost"} to get a class`}
				>
					Classes rank products by units sold times cost. Products showing a
					dash in the Class column are left out until they have one.
				</Banner>
			)}
			{aboutValue && (
				<p className="-mt-1 text-muted-foreground">
					A is the products carrying the first 80% of the money spent on stock,
					B the next 15%, C the rest. Based on{" "}
					{abcDays >= 365
						? "the last 12 months"
						: `${formatCount(abcDays)} days`}{" "}
					of sales.
				</p>
			)}
			<div className="flex items-start gap-6">
				<aside className="sticky top-4 hidden max-h-[calc(100svh-6rem)] w-56 shrink-0 overflow-y-auto pb-4 lg:block">
					<FacetRail
						groups={RAIL}
						counts={railCounts}
						filters={filters}
						onFilters={(next) => setSearch({ filters: next })}
					/>
				</aside>
				<div ref={list} className="flex min-w-0 flex-1 flex-col gap-3">
					<Card flush>
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
									placeholder="Search, or filter: #tag @type $vendor %status ^class >=3 inventory"
									onKeyDown={(e) => {
										if (e.key === "Enter") open(filtered[selected]);
										if (e.key === "ArrowDown") {
											e.preventDefault();
											setSelected((i) => Math.min(i + 1, last));
										}
										if (e.key === "ArrowUp") {
											e.preventDefault();
											setSelected((i) => Math.max(i - 1, 0));
										}
									}}
								/>
							</div>
							<AddFilter
								counts={facetValues}
								onAdd={(f) => setSearch({ filters: [...filters, f] })}
							/>
							<SortMenu sort={sort} onSort={(s) => setSearch({ sort: s })} />
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
										<th className="hidden px-4 py-2 font-medium md:table-cell">
											Reorder
										</th>
										<th className="hidden px-4 py-2 font-medium 2xl:table-cell">
											Type
										</th>
									</tr>
								</thead>
								{/* One menu for the whole list: right-clicking a row selects it,
					    and the menu acts on the selected product. */}
								<ContextMenu>
									<ContextMenuTrigger asChild>
										<tbody>
											{filtered.slice(0, shown).map((p, i) => (
												<tr
													key={p.id}
													data-index={i}
													onClick={() => open(p)}
													onMouseMove={() => setSelected(i)}
													onContextMenu={() => setSelected(i)}
													className={cn(
														"cursor-pointer border-t first:border-t-0",
														i === selected ? "bg-surface" : "hover:bg-subtle",
													)}
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
														{/* Tool sets are classed through their parts. */}
														{p.kind !== "bundle" && (
															<AbcBadge
																abc={p.abc}
																title={
																	p.abcRank !== null
																		? `#${formatCount(p.abcRank)} by value`
																		: "Needs a cost to get a class"
																}
															/>
														)}
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
									{filtered[selected] && (
										<RowMenu
											product={filtered[selected]}
											onOpen={open}
											onAddToPo={addToPo}
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
									{filtered.slice(0, shown).map((p, i) => (
										<StockCard
											key={p.id}
											product={p}
											state={stateFor(p)}
											index={i}
											selected={i === selected}
											now={now}
											onOpen={() => open(p)}
											onSelect={() => setSelected(i)}
											onOrder={() => addToPo(p)}
											onCount={() => countStock(p)}
										/>
									))}
								</div>
							</ContextMenuTrigger>
							{filtered[selected] && (
								<RowMenu
									product={filtered[selected]}
									onOpen={open}
									onAddToPo={addToPo}
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
						navigate({ to: "/products", search: { view: id, ...current } });
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
		try {
			const { added, purchaseOrderId, supplierName, line } =
				await addToPurchaseOrder({
					data: { productId: p.id, quantity: p.reorder?.quantity },
				});
			await router.invalidate();
			if (!added) {
				toast(
					`${p.sku} is already on PO ${purchaseOrderId}: ${formatOrderQuantity(line)}`,
				);
				return;
			}
			toast.success(
				`Added ${formatOrderQuantity(line)} to PO ${purchaseOrderId} (${supplierName})`,
				{
					action: {
						label: "Undo",
						onClick: async () => {
							try {
								const undone = await undoAddToPurchaseOrder({
									data: { purchaseOrderId, line },
								});
								await router.invalidate();
								if (!undone)
									toast(
										`${p.sku} on PO ${purchaseOrderId} changed since, so it's left as is`,
									);
							} catch (err) {
								toast.error(err instanceof Error ? err.message : String(err));
							}
						},
					},
				},
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}

	async function countStock(p: ProductRow) {
		try {
			const added = await requestCount({ data: { productId: p.id } });
			if (added.length === 0) {
				toast(`${p.sku} is already on the count list`);

				return;
			}
			await router.invalidate();
			toast.success(`Added ${p.sku} to the count list`, {
				action: {
					label: "Undo",
					onClick: async () => {
						try {
							const cancelled = await cancelCountRequest({
								data: { requests: added },
							});
							await router.invalidate();
							if (cancelled < added.length)
								toast(
									`${p.sku}'s count request changed since, so it's left as is`,
								);
						} catch (err) {
							toast.error(err instanceof Error ? err.message : String(err));
						}
					},
				},
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}

	async function updateView(v: View) {
		await saveView({ data: { id: v.id, name: v.name, ...current } });
		await router.invalidate();
		toast.success(`Saved “${v.name}”`, {
			action: {
				label: "Undo",
				onClick: async () => {
					await saveView({ data: v });
					await router.invalidate();
				},
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
	search: { filters: Filter[]; sort: Sort };
	onClose: () => void;
	onSaved: (id: number) => void;
	onDeleted: () => void;
}) {
	const router = useRouter();
	const [name, setName] = useState(view?.name ?? "");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const { id } = await saveView({
				data: view ? { ...view, name } : { name, ...search },
			});
			await router.invalidate();
			onSaved(id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	async function remove() {
		if (!view) return;
		await deleteView({ data: { id: view.id } });
		await router.invalidate();
		onDeleted();
		toast(`Deleted “${view.name}”`, {
			action: {
				label: "Undo",
				onClick: async () => {
					const { id: _, ...rest } = view;
					await saveView({ data: rest });
					await router.invalidate();
				},
			},
		});
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
					{error && <p className="text-critical-text">{error}</p>}
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

// What putting this product on a PO means right now. Tool sets are ordered
// through their parts, so they get nothing.
function orderAction(p: ProductRow) {
	if (p.kind === "bundle") return null;
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
	onCount,
}: {
	product: ProductRow;
	onOpen: (p: ProductRow) => void;
	onAddToPo: (p: ProductRow) => void;
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
			{p.kind !== "bundle" && (
				<ContextMenuItem onSelect={() => onCount(p)} shortcut="C">
					<ClipboardList />
					Count stock
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			<ContextMenuItem
				onSelect={async () => {
					await navigator.clipboard.writeText(p.sku);
					toast(`Copied ${p.sku}`);
				}}
			>
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
