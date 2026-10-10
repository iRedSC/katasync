import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { type } from "arktype";
import { Pencil } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AddFilter, SortMenu } from "#/components/filter-menu";
import { FilterSearch } from "#/components/filter-search";
import { AbcBadge, Badge, Banner, Card, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import {
	type Facets,
	type Filter,
	facetCounts,
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
import { listProducts, type ProductRow } from "#/server/catalog";
import { deleteView, listViews, saveView } from "#/server/views";

// The URL holds the chips and sort, so links (like Home's "Oversold") and the
// back button work. `view` is the saved view they came from, so it can be
// updated. Anything malformed is dropped rather than failing the page.
type Search = { view?: number; filters?: Filter[]; sort?: Sort };

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

// What the search language can filter each product on. Status covers
// Shopify's (active, draft, archived), the problems the Status column shows,
// and whether it's a tool set or kit.
function facetsOf(p: ProductRow): Facets {
	const title = p.variantName ? `${p.name} ${p.variantName}` : p.name;
	const status = p.status ? [p.status.toLowerCase()] : [];
	if ((p.onHand ?? 0) < 0) status.push("oversold");
	else if (p.kind === "bundle" && p.available === 0)
		status.push("missing parts");
	else if (p.available === 0) status.push("sold out");
	if (p.kind === "bundle") status.push("tool set");
	if (p.kind === "kit") status.push("kit");
	return {
		text: [p.sku, title, p.category ?? ""],
		title: [title],
		tag: p.tags,
		type: p.category ? [p.category] : [],
		vendor: p.vendor ? [p.vendor] : [],
		status,
		class: p.abc ? [p.abc] : [],
		inventory: stock(p),
	};
}

// Name order comes from the server; the rest re-sort from it, so ties stay
// in name order.
function sorted(products: ProductRow[], sort: Sort) {
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
	const list = useRef<HTMLTableSectionElement>(null);
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

	const facets = useMemo(() => products.map(facetsOf), [products]);
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
		);
	}, [products, facets, query, filters, sort]);

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
			search: v ? { view: v.id, filters: v.filters, sort: v.sort } : {},
		});
	}

	useHotkeys({
		"/": () => input.current?.focus(),
		j: () => setSelected((i) => Math.min(i + 1, last)),
		k: () => setSelected((i) => Math.max(i - 1, 0)),
		Enter: () => open(filtered[selected]),
		Escape: () => {
			if (document.activeElement === input.current) input.current?.blur();
			else if (query) setQuery("");
		},
	});

	const aboutValue =
		sort === "value" || filters.some((f) => f.field === "class");

	return (
		<Page title="Products">
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

				<table className="w-full">
					<thead>
						<tr className="border-b bg-[#f7f7f7] text-left text-xs text-muted-foreground">
							<th className="px-4 py-2 font-medium">Product</th>
							<th className="px-2 py-2 text-center font-medium">Class</th>
							<th className="hidden px-4 py-2 font-medium md:table-cell">
								Status
							</th>
							<th className="px-4 py-2 font-medium">Inventory</th>
							<th className="hidden px-4 py-2 font-medium lg:table-cell">
								Type
							</th>
						</tr>
					</thead>
					<tbody ref={list}>
						{filtered.slice(0, shown).map((p, i) => (
							<tr
								key={p.id}
								data-index={i}
								onClick={() => open(p)}
								onMouseMove={() => setSelected(i)}
								className={cn(
									"cursor-pointer border-t first:border-t-0",
									i === selected ? "bg-[#f1f1f1]" : "hover:bg-[#f7f7f7]",
								)}
							>
								{/* Takes the width the other columns leave, so long names end
								    in "…" instead of pushing them off the card. */}
								<td className="w-full max-w-0 px-4 py-2">
									<div className="flex items-center gap-3">
										<ProductImage src={p.imageUrl} />
										<div className="min-w-0 flex-1">
											<ProductName name={p.name} variantName={p.variantName} />
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
								<td className="hidden px-4 py-2 whitespace-nowrap text-muted-foreground lg:table-cell">
									{p.category ?? ""}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{filtered.length === 0 && (
					<p className="py-16 text-center text-muted-foreground">
						No products match. Try a shorter search.
					</p>
				)}
				{shown < filtered.length && (
					<div className="flex justify-center border-t p-3">
						<Button variant="outline" onClick={() => setShown((n) => n + PAGE)}>
							Show {formatCount(Math.min(PAGE, filtered.length - shown))} more
						</Button>
					</div>
				)}
			</Card>

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
					? "bg-[#e3e3e3] text-foreground"
					: "text-muted-foreground hover:bg-[#f1f1f1] hover:text-foreground",
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
					className="-ml-1.5 mr-1 rounded p-1 text-muted-foreground hover:bg-[#d4d4d4] hover:text-foreground"
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
						className="h-9 rounded-lg border border-[#8a8a8a] px-3 outline-none focus:border-ring focus:ring-1 focus:ring-ring"
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
