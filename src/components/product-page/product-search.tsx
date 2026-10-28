import { Command as CommandPrimitive } from "cmdk";
import { Loader2, RotateCw, Search } from "lucide-react";
import { useState } from "react";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import { type IndexedProduct, useProductIndex } from "#/lib/product-index";
import { productSearch } from "#/lib/product-search";

export type { IndexedProduct };

// Picks a carried product by SKU or name. `refuse` says why one can't be
// picked here, which shows in its row and keeps it from being picked, so
// nothing the server would turn down can be sent. Escape clears, then leaves.
export function ProductSearch({
	placeholder,
	refuse,
	busy = false,
	autoFocus,
	onPick,
	onEscape,
	className,
}: {
	placeholder: string;
	refuse: (p: IndexedProduct) => string | null;
	// Something picked is on its way; the field waits for it.
	busy?: boolean;
	autoFocus?: boolean;
	onPick: (p: IndexedProduct) => void;
	onEscape?: () => void;
	className?: string;
}) {
	const index = useProductIndex();
	const products = index.status === "ready" ? index.products : null;
	const [query, setQuery] = useState("");
	const results = products ? productSearch(products, query, { limit: 20 }) : [];

	return (
		<CommandPrimitive
			shouldFilter={false}
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				// Not the page's Escape, which goes back.
				e.preventDefault();
				e.stopPropagation();
				if (query) setQuery("");
				else if (onEscape) onEscape();
				else (e.target as HTMLElement).blur();
			}}
			className={className}
		>
			<div className="flex items-center gap-2 px-4 py-2">
				<Search className="size-4 shrink-0 text-muted-foreground" />
				<CommandPrimitive.Input
					autoFocus={autoFocus}
					value={query}
					onValueChange={setQuery}
					disabled={busy}
					placeholder={placeholder}
					className="h-9 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
				/>
				{(busy || (query.trim() !== "" && index.status === "loading")) && (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				)}
			</div>
			{index.status === "failed" && (
				<div className="flex items-center gap-2 border-t px-4 py-2 text-critical-text">
					<span className="min-w-0 flex-1 truncate">
						Couldn't load products: {index.message}
					</span>
					<Button variant="ghost" size="sm" onClick={index.retry}>
						<RotateCw />
						Retry
					</Button>
				</div>
			)}
			{query.trim() !== "" && products && !busy && (
				<CommandPrimitive.List className="max-h-80 overflow-y-auto border-t p-1">
					{results.length === 0 && (
						<p className="px-3 py-4 text-muted-foreground">No products</p>
					)}
					{results.map((p) => {
						const why = refuse(p);
						return (
							<CommandPrimitive.Item
								key={p.id}
								value={p.sku}
								disabled={why !== null}
								onSelect={() => {
									setQuery("");
									onPick(p);
								}}
								className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface"
							>
								<ProductImage src={p.imageUrl} className="size-9" />
								<div className="min-w-0 flex-1">
									<ProductName name={p.name} variantName={p.variantName} />
									<div className="text-xs text-muted-foreground">{p.sku}</div>
								</div>
								{why && (
									<span className="shrink-0 text-xs text-muted-foreground">
										{why}
									</span>
								)}
							</CommandPrimitive.Item>
						);
					})}
				</CommandPrimitive.List>
			)}
		</CommandPrimitive>
	);
}
