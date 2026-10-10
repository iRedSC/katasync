import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilterSearch } from "#/components/filter-search";
import { Badge, Card, Page } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import {
	type Facets,
	facetCounts,
	matches,
	parseQuery,
	type Filter as SearchFilter,
} from "#/products/search";
import { listProducts, type ProductRow } from "#/server/catalog";

// Saved views, shown as tabs like Shopify's product index.
const filters = {
	all: { label: "All", test: () => true },
	oversold: {
		label: "Oversold",
		test: (p: ProductRow) => (p.onHand ?? 0) < 0,
	},
	blocked: {
		label: "Tool sets missing parts",
		test: (p: ProductRow) => p.kind === "bundle" && p.available === 0,
	},
	out: {
		label: "Sold out",
		test: (p: ProductRow) => p.kind !== "bundle" && p.available === 0,
	},
	bundles: { label: "Tool sets", test: (p: ProductRow) => p.kind === "bundle" },
} as const;
type Filter = keyof typeof filters;

export const Route = createFileRoute("/products/")({
	validateSearch: (search: Record<string, unknown>): { show?: Filter } =>
		typeof search.show === "string" && search.show in filters
			? { show: search.show as Filter }
			: {},
	loader: () => listProducts(),
	component: Products,
});

const PAGE = 100;

// What the search language can filter each product on. Status covers both
// Shopify's (active, draft, archived) and the problems the Status column shows.
function facetsOf(p: ProductRow): Facets {
	const title = p.variantName ? `${p.name} ${p.variantName}` : p.name;
	const status = p.status ? [p.status.toLowerCase()] : [];
	if ((p.onHand ?? 0) < 0) status.push("oversold");
	else if (p.kind === "bundle" && p.available === 0)
		status.push("missing parts");
	else if (p.available === 0) status.push("sold out");
	return {
		text: [p.sku, title, p.category ?? ""],
		title: [title],
		tag: p.tags,
		type: p.category ? [p.category] : [],
		vendor: p.vendor ? [p.vendor] : [],
		status,
	};
}

function Products() {
	const products = Route.useLoaderData();
	const { show = "all" } = Route.useSearch();
	const navigate = useNavigate();
	const search = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLTableSectionElement>(null);
	const [query, setQuery] = useState("");
	const [chips, setChips] = useState<SearchFilter[]>([]);
	const [shown, setShown] = useState(PAGE);
	const [selected, setSelected] = useState(0);

	const counts = useMemo(
		() =>
			Object.fromEntries(
				Object.entries(filters).map(([key, f]) => [
					key,
					products.filter(f.test).length,
				]),
			) as Record<Filter, number>,
		[products],
	);

	const facets = useMemo(() => products.map(facetsOf), [products]);
	const facetValues = useMemo(() => facetCounts(facets), [facets]);
	const filtered = useMemo(() => {
		const q = parseQuery(query);
		const all = [...chips, ...q.filters];
		return products.filter(
			(p, i) => filters[show].test(p) && matches(facets[i], all, q.words),
		);
	}, [products, facets, query, chips, show]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the list changes
	useEffect(() => setSelected(0), [query, chips, show]);
	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${selected}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	const last = Math.min(shown, filtered.length) - 1;
	const open = (p: ProductRow | undefined) =>
		p && navigate({ to: "/products/$sku", params: { sku: p.sku } });

	useHotkeys({
		"/": () => search.current?.focus(),
		j: () => setSelected((i) => Math.min(i + 1, last)),
		k: () => setSelected((i) => Math.max(i - 1, 0)),
		Enter: () => open(filtered[selected]),
		Escape: () => {
			if (document.activeElement === search.current) search.current?.blur();
			else if (query || chips.length) {
				setQuery("");
				setChips([]);
			}
		},
	});

	return (
		<Page title="Products">
			<Card flush>
				<div className="flex flex-wrap gap-1 border-b p-2">
					{(Object.keys(filters) as Filter[]).map((key) => (
						<button
							key={key}
							type="button"
							onClick={() =>
								navigate({
									to: "/products",
									search: key === "all" ? {} : { show: key },
								})
							}
							className={cn(
								"inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 font-medium",
								show === key
									? "bg-[#e3e3e3] text-foreground"
									: "text-muted-foreground hover:bg-[#f1f1f1] hover:text-foreground",
							)}
						>
							{filters[key].label}
							<span className="tabular-nums text-muted-foreground">
								{formatCount(counts[key])}
							</span>
						</button>
					))}
				</div>
				<div className="border-b p-2">
					<FilterSearch
						inputRef={search}
						text={query}
						onText={(text) => {
							setQuery(text);
							setShown(PAGE);
						}}
						chips={chips}
						onChips={(next) => {
							setChips(next);
							setShown(PAGE);
						}}
						counts={facetValues}
						placeholder="Search, or filter: #tag @type $vendor %status, #!tag to exclude"
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

				<table className="w-full">
					<thead>
						<tr className="border-b bg-[#f7f7f7] text-left text-xs text-muted-foreground">
							<th className="px-4 py-2 font-medium">Product</th>
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
		</Page>
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
				{formatCount(p.onHand ?? 0)} in stock
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
