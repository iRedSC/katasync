import { Command as CommandPrimitive } from "cmdk";
import { ArrowRight, Loader2, Plus, RotateCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { CatalogMark } from "#/components/catalog-mark";
import { ProductImage } from "#/components/product";
import { Button } from "#/components/ui/button";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import {
	findProductsForCatalog,
	restoreProductCatalogs,
	setProductCatalog,
} from "#/server/purchasing";
import { searchView } from "./search-answer";

type Found = Awaited<ReturnType<typeof findProductsForCatalog>>[number];

// Finds products by SKU or name to put in this catalog. One in another
// catalog says so on its row, and Undo moves it back. Only the newest
// search's answer is kept, and only an answer to what's typed can be picked,
// so Enter never adds a row from the query before.
export function AddProducts({
	catalog,
}: {
	catalog: { id: number; name: string; photoId: number | null };
}) {
	const [query, setQuery] = useState("");
	const [found, setFound] = useState<{ q: string; rows: Found[] } | null>(null);
	const [busy, setBusy] = useState(false);
	// A search that didn't come back, for the query it was for.
	const [failed, setFailed] = useState<{ q: string; message: string } | null>(
		null,
	);
	// Bumped to search the same query again.
	const [attempt, setAttempt] = useState(0);
	const q = query.trim();

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the same query
	useEffect(() => {
		setFailed(null);
		if (q === "") {
			setFound(null);
			return;
		}
		let current = true;
		const timer = setTimeout(() => {
			findProductsForCatalog({ data: { query: q } }).then(
				(rows) => current && setFound({ q, rows }),
				(err) =>
					current &&
					setFailed({
						q,
						message: err instanceof Error ? err.message : String(err),
					}),
			);
		}, 150);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [q, attempt]);

	async function add(p: Found) {
		if (found?.q !== q) return;
		setBusy(true);
		const r = await optimism.change({
			send: () =>
				setProductCatalog({
					data: { productIds: [p.id], catalogId: catalog.id },
				}),
		});
		setBusy(false);
		if (!r) return;
		setQuery("");
		offerUndo(
			p.catalogName ? `Moved ${p.sku} from ${p.catalogName}` : `Added ${p.sku}`,
			{
				tone: "success",
				undo: async () => {
					const back = await optimism.change({
						send: () => restoreProductCatalogs({ data: { before: r.value } }),
					});
					return (
						back && (p.catalogName ? `Back in ${p.catalogName}` : "Taken out")
					);
				},
			},
		);
	}

	const view = searchView(found, q, failed?.q ?? null);
	return (
		<CommandPrimitive shouldFilter={false} className="relative" loop>
			<div className="flex items-center gap-2 border-b px-4">
				{busy || view.searching ? (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				) : (
					<Search className="size-4 text-muted-foreground" />
				)}
				<CommandPrimitive.Input
					value={query}
					onValueChange={setQuery}
					onKeyDown={(e) => {
						if (e.key === "Escape") setQuery("");
					}}
					placeholder={`Add products to ${catalog.name} by SKU or name`}
					className="h-11 flex-1 bg-transparent outline-none"
				/>
			</div>
			{q !== "" && (
				<CommandPrimitive.List className="absolute inset-x-2 top-12 z-20 max-h-80 overflow-y-auto rounded-xl bg-popover p-1 shadow-md ring-1 ring-black/5">
					{view.failed && (
						<div className="flex items-center gap-2 px-3 py-3 text-critical-text">
							<span className="min-w-0 flex-1 truncate">
								Couldn't search: {failed?.message}
							</span>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setAttempt((n) => n + 1)}
							>
								<RotateCw />
								Retry
							</Button>
						</div>
					)}
					{!view.searching && !view.failed && view.rows.length === 0 && (
						<CommandPrimitive.Empty className="px-3 py-6 text-center text-muted-foreground">
							No product matches “{q}”
						</CommandPrimitive.Empty>
					)}
					{view.rows.map((p) => {
						const here = p.catalogId === catalog.id;
						return (
							<CommandPrimitive.Item
								key={p.id}
								value={String(p.id)}
								disabled={here || busy || view.stale}
								onSelect={() => add(p)}
								className={cn(
									"flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 data-[selected=true]:bg-surface",
									view.stale && "opacity-60",
									here && "cursor-default opacity-50",
								)}
							>
								<ProductImage src={p.imageUrl} className="size-8" />
								<span className="min-w-0 flex-1">
									<span className="block truncate">
										{p.variantName ? `${p.name} ${p.variantName}` : p.name}
									</span>
									<span className="block truncate text-xs text-muted-foreground">
										{p.sku}
									</span>
								</span>
								{here ? (
									<span className="text-xs text-muted-foreground">
										In it already
									</span>
								) : p.catalogId !== null && p.catalogName !== null ? (
									<span className="inline-flex items-center gap-1 rounded-md bg-warning-surface px-1.5 py-0.5 text-xs text-warning-text">
										Moves from {p.catalogName}
										<ArrowRight className="size-3" />
										<CatalogMark catalog={catalog} size="xs" />
									</span>
								) : (
									<Plus className="size-4 text-muted-foreground" />
								)}
							</CommandPrimitive.Item>
						);
					})}
				</CommandPrimitive.List>
			)}
		</CommandPrimitive>
	);
}
