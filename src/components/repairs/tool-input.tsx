import { useState } from "react";
import { ProductImage, ProductName } from "#/components/product";
import type { IndexedProduct } from "#/components/transfers/add-product";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "#/components/ui/popover";
import { cn } from "#/lib/utils";

// What the tool is: picked from the catalog as its name is typed, or
// typed out for one we don't sell. Enter keeps the typing unless a match
// was arrowed to.

const MATCHES = 6;

export const toolName = (p: IndexedProduct) =>
	p.variantName ? `${p.name} (${p.variantName})` : p.name;

// Every word somewhere in the SKU or name. Whole tools rank above parts
// (named "[part number] ..."), then the typing as one phrase, then shorter
// names, so "tapetech taper" finds the taper before the kits for it.
function matching(products: IndexedProduct[], text: string) {
	const phrase = text.trim().toLowerCase();
	const words = phrase.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const found = products.filter((p) => {
		if (p.kind === "bundle") return false;
		const hay = `${p.sku} ${p.name} ${p.variantName ?? ""}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
	// Already exactly this product: nothing left to offer.
	if (found.some((p) => toolName(p).toLowerCase() === phrase)) return [];
	const rank = (p: IndexedProduct) =>
		(p.name.startsWith("[") ? 10_000 : 0) +
		(toolName(p).toLowerCase().includes(phrase) ? 0 : 1_000) +
		toolName(p).length;
	return found.sort((a, b) => rank(a) - rank(b)).slice(0, MATCHES);
}

export function ToolInput({
	value,
	products,
	onChange,
	onDone,
	disabled,
	placeholder = "Tool",
	className,
}: {
	value: string;
	products: IndexedProduct[];
	onChange: (text: string) => void;
	// Typing finished: blurred, Enter, or a product picked.
	onDone?: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(-1);
	const matches = open ? matching(products, value) : [];

	function pick(p: IndexedProduct) {
		const name = toolName(p);
		onChange(name);
		setOpen(false);
		onDone?.(name);
	}

	return (
		<Popover
			open={matches.length > 0}
			onOpenChange={(o) => {
				if (!o) setOpen(false);
			}}
		>
			<PopoverAnchor asChild>
				<input
					value={value}
					disabled={disabled}
					placeholder={disabled ? "" : placeholder}
					onFocus={() => setOpen(true)}
					onChange={(e) => {
						onChange(e.target.value);
						setOpen(true);
						setActive(-1);
					}}
					onBlur={() => {
						setOpen(false);
						onDone?.(value);
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
					className={cn("w-full min-w-0", className)}
				/>
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
