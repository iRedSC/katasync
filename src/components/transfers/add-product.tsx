import { Search } from "lucide-react";
import { useState } from "react";
import { ProductImage, ProductName } from "#/components/product";
import { cn } from "#/lib/utils";

export type IndexedProduct = {
	id: number;
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	kind: "simple" | "kit" | "bundle";
};

// Finds a product to put on a transfer by SKU or name. Tool sets aren't
// offered: they have no stock of their own and move as their parts.
export function AddProduct({
	products,
	onAdd,
	exclude,
}: {
	products: IndexedProduct[];
	onAdd: (product: IndexedProduct) => void;
	// Already on the transfer.
	exclude: Set<number>;
}) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const q = query.trim().toLowerCase();
	const matches =
		q === ""
			? []
			: products
					.filter(
						(p) =>
							p.kind !== "bundle" &&
							!exclude.has(p.id) &&
							(p.sku.toLowerCase().includes(q) ||
								p.name.toLowerCase().includes(q)),
					)
					.slice(0, 8);

	function pick(p: IndexedProduct) {
		onAdd(p);
		setQuery("");
		setActive(0);
	}

	return (
		<div className="relative">
			<div className="flex items-center gap-2 px-4 py-3">
				<Search className="size-4 text-muted-foreground" />
				<input
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActive(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown")
							setActive((a) => Math.min(a + 1, matches.length - 1));
						if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
						if (e.key === "Enter" && matches[active]) {
							e.preventDefault();
							pick(matches[active]);
						}
					}}
					placeholder="Add a product by SKU or name"
					className="w-full bg-transparent outline-none"
				/>
			</div>
			{q !== "" && (
				<ul className="border-t">
					{matches.length === 0 && (
						<li className="px-4 py-2.5 text-muted-foreground">
							Nothing matches that isn't on here already.
						</li>
					)}
					{matches.map((p, i) => (
						<li key={p.id}>
							<button
								type="button"
								onClick={() => pick(p)}
								onMouseEnter={() => setActive(i)}
								className={cn(
									"flex w-full items-center gap-3 px-4 py-2 text-left",
									i === active && "bg-subtle",
								)}
							>
								<ProductImage src={p.imageUrl} className="size-8" />
								<div className="min-w-0 flex-1">
									<ProductName name={p.name} variantName={p.variantName} />
									<div className="text-xs text-muted-foreground">{p.sku}</div>
								</div>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
