import { useState } from "react";
import { ProductImage, ProductName } from "#/components/product";
import type { IndexedProduct } from "#/components/transfers/add-product";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "#/components/ui/popover";
import { productSearch } from "#/lib/product-search";
import { cn } from "#/lib/utils";

// What the tool is: picked from the catalog as its name is typed, showing
// its photo, or typed out for one we don't sell. Typing over a picked one
// makes it typed out. Enter keeps the typing unless a match was arrowed to.

const MATCHES = 6;

export const toolName = (p: IndexedProduct) =>
	p.variantName ? `${p.name} (${p.variantName})` : p.name;

// Whole tools rank above their parts here; typos and word order are
// forgiven (src/lib/product-search.ts).
function matching(products: IndexedProduct[], text: string) {
	const found = productSearch(products, text, {
		limit: MATCHES + 1,
		where: (p) => p.kind !== "bundle",
		prefer: (p) => !p.part,
	});
	// Already exactly this product: nothing left to offer.
	const typed = text.trim().toLowerCase();
	if (found.some((p) => toolName(p).toLowerCase() === typed)) return [];
	return found.slice(0, MATCHES);
}

export function ToolInput({
	value,
	productId,
	products,
	onChange,
	onDone,
	disabled,
	placeholder = "Tool",
	className,
}: {
	value: string;
	// The catalog product it is, or null when typed out.
	productId: number | null;
	products: IndexedProduct[];
	onChange: (text: string, productId: number | null) => void;
	// Typing finished: blurred, Enter, or a product picked.
	onDone?: (text: string, productId: number | null) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const matches = open ? matching(products, value) : [];
	const picked =
		productId === null ? null : products.find((p) => p.id === productId);

	function pick(p: IndexedProduct) {
		const name = toolName(p);
		onChange(name, p.id);
		setOpen(false);
		onDone?.(name, p.id);
	}

	return (
		<Popover
			open={matches.length > 0}
			onOpenChange={(o) => {
				if (!o) setOpen(false);
			}}
		>
			<PopoverAnchor asChild>
				<div className={cn("flex items-center gap-2", className)}>
					{picked && (
						<ProductImage
							key={picked.id}
							src={picked.imageUrl}
							className="size-6 shrink-0 animate-in fade-in zoom-in-90"
						/>
					)}
					<input
						value={value}
						disabled={disabled}
						placeholder={disabled ? "" : placeholder}
						onFocus={() => setOpen(true)}
						onChange={(e) => {
							const text = e.target.value;
							// Typed over: no longer that product.
							onChange(
								text,
								picked && text === toolName(picked) ? picked.id : null,
							);
							setOpen(true);
							setActive(-1);
						}}
						onBlur={() => {
							setOpen(false);
							onDone?.(value, picked?.id ?? null);
						}}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setActive((a) => Math.min(a + 1, matches.length - 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setActive((a) => Math.max(a - 1, -1));
							} else if (e.key === "Enter") {
								const p = matches[active];
								if (p) {
									e.preventDefault();
									pick(p);
								} else if (onDone) e.currentTarget.blur();
							}
						}}
						className="h-full w-full min-w-0 bg-transparent outline-none"
					/>
				</div>
			</PopoverAnchor>
			<PopoverContent
				align="start"
				collisionPadding={16}
				// The typing stays in the input.
				onOpenAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
				className="w-[26rem] min-w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)]"
			>
				<ul>
					{matches.map((p, i) => (
						<li key={p.id}>
							<button
								type="button"
								tabIndex={-1}
								// Keeps the input focused, so its blur doesn't close
								// the list before the click lands.
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => pick(p)}
								onMouseEnter={() => setActive(i)}
								className={cn(
									"flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm font-normal text-foreground",
									i === active && "bg-subtle",
								)}
							>
								<ProductImage src={p.imageUrl} className="size-7" />
								<div className="min-w-0 flex-1">
									<ProductName name={p.name} variantName={p.variantName} />
									<div className="text-xs text-muted-foreground">{p.sku}</div>
								</div>
							</button>
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
