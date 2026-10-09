import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageBody, PageHeader, StatusDot } from "#/components/page";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import { formatCount } from "#/lib/format";
import { useHotkeys } from "#/lib/hotkeys";
import { cn } from "#/lib/utils";
import { listProducts, type ProductRow } from "#/server/catalog";

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

function Products() {
	const products = Route.useLoaderData();
	const { show = "all" } = Route.useSearch();
	const navigate = useNavigate();
	const search = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLUListElement>(null);
	const [query, setQuery] = useState("");
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

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return products.filter(
			(p) =>
				filters[show].test(p) &&
				(q === "" ||
					p.sku.toLowerCase().includes(q) ||
					p.name.toLowerCase().includes(q) ||
					p.category?.toLowerCase().includes(q)),
		);
	}, [products, query, show]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the list changes
	useEffect(() => setSelected(0), [query, show]);
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
			else if (query) setQuery("");
		},
	});

	return (
		<>
			<PageHeader title="Products" />
			<PageBody className="gap-6">
				<div className="flex flex-col gap-4">
					<div className="relative">
						<Search className="absolute top-3 left-3 size-5 text-muted-foreground" />
						<input
							ref={search}
							placeholder="Search by name or SKU"
							className="h-11 w-full rounded-lg border bg-transparent pr-12 pl-11 text-base outline-none focus:border-primary"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setShown(PAGE);
							}}
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
						<kbd className="absolute top-3 right-3 rounded border px-1.5 text-xs text-muted-foreground">
							/
						</kbd>
					</div>
					<div className="flex flex-wrap gap-2">
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
									"inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors",
									show === key
										? "border-foreground bg-foreground text-background"
										: "hover:bg-accent",
								)}
							>
								{key === "oversold" && <Dot tone="bg-bad" />}
								{key === "blocked" && <Dot tone="bg-warn" />}
								{filters[key].label}
								<span className="tabular-nums opacity-60">
									{formatCount(counts[key])}
								</span>
							</button>
						))}
					</div>
				</div>

				<ul ref={list} className="flex flex-col">
					{filtered.slice(0, shown).map((p, i) => (
						<li key={p.id} data-index={i}>
							<button
								type="button"
								onClick={() => open(p)}
								onMouseMove={() => setSelected(i)}
								className={cn(
									"flex w-full items-center gap-4 rounded-lg px-3 py-2.5 text-left",
									i === selected && "bg-accent",
								)}
							>
								<ProductImage src={p.imageUrl} />
								<div className="min-w-0 flex-1">
									<div className="truncate">
										{p.name}
										{p.variantName && (
											<span className="text-muted-foreground">
												{" "}
												· {p.variantName}
											</span>
										)}
									</div>
									<div className="flex items-center gap-2 text-xs text-muted-foreground">
										<span className="font-mono">{p.sku}</span>
										{p.kind !== "simple" && (
											<span>{p.kind === "bundle" ? "Tool set" : "Kit"}</span>
										)}
									</div>
								</div>
								<RowStatus product={p} />
								<div className="w-16 text-right">
									<div
										className={cn(
											"text-lg font-semibold tabular-nums",
											p.available === 0 && "text-muted-foreground/60",
										)}
									>
										{formatCount(p.available)}
									</div>
									<div className="text-xs text-muted-foreground">to sell</div>
								</div>
							</button>
						</li>
					))}
				</ul>
				{filtered.length === 0 && (
					<p className="py-16 text-center text-muted-foreground">
						Nothing matches.
					</p>
				)}
				{shown < filtered.length && (
					<Button
						variant="ghost"
						className="self-center text-muted-foreground"
						onClick={() => setShown((n) => n + PAGE)}
					>
						Show {formatCount(Math.min(PAGE, filtered.length - shown))} more
					</Button>
				)}
			</PageBody>
		</>
	);
}

function Dot({ tone }: { tone: string }) {
	return <span className={cn("size-2 rounded-full", tone)} />;
}

// Only problems get a label. A healthy row stays quiet.
function RowStatus({ product: p }: { product: ProductRow }) {
	if ((p.onHand ?? 0) < 0) {
		return (
			<StatusDot tone="bad">
				Oversold by {formatCount(-(p.onHand ?? 0))}
			</StatusDot>
		);
	}
	if (p.kind === "bundle" && p.available === 0) {
		return <StatusDot tone="warn">Missing parts</StatusDot>;
	}
	return null;
}
