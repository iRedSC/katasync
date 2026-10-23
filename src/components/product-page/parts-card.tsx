import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, Card } from "#/components/page";
import { ProductName } from "#/components/product";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { formatCount } from "#/lib/format";
import { optimism, optimistic, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { ProductDetail } from "#/server/catalog";
import { setProductParts } from "#/server/catalog/product-edits";
import { KitDialog, type KitDirection } from "./kit-dialog";
import { type IndexedProduct, ProductSearch } from "./product-search";

type Part = ProductDetail["components"][number];

// The product page's data, patched under the same key as the page's own.
const productData = optimistic<ProductDetail>("product");

const partsPatch = (productId: number, parts: Part[]) =>
	productData.patch(productId, (d) => ({ ...d, components: parts }));

// What each kind may hold, as setRecipe allows: kits hold single products,
// tool sets hold those or kits. Nothing holds a tool set.
function refusal(
	parent: ProductDetail["product"],
	parts: Part[],
	p: IndexedProduct,
) {
	if (p.id === parent.id) return "This product";
	if (parts.some((c) => c.id === p.id)) return "Already a part";
	if (p.kind === "bundle") return "Tool sets can't be parts";
	if (p.kind === "kit" && parent.kind === "kit") return "Kits can't hold kits";
	return null;
}

// Whether a part is what caps how many of the set can be sold, once few are
// left.
export function limits(d: ProductDetail, c: Part) {
	return (
		d.product.kind === "bundle" &&
		d.available <= 3 &&
		c.available >= c.quantity &&
		Math.floor(c.available / c.quantity) === d.available
	);
}

// What a kit or tool set is made of, changed right here: add a part by
// typing, change how many go in one, or take one out. Every change can be
// undone. A kit is also built and taken apart from here.
export function PartsCard({
	d,
	kitPatch,
}: {
	d: ProductDetail;
	// How building (positive) or taking apart (negative) kits at a location
	// shows on the page.
	kitPatch: (location: { id: number; name: string }, kits: number) => Patch;
}) {
	const p = d.product;
	const parts = d.components;
	const [adding, setAdding] = useState(false);
	// The part just added, lit up for a moment so it's seen arriving.
	const [fresh, setFresh] = useState<string | null>(null);
	const [converting, setConverting] = useState<KitDirection | null>(null);
	const label = `Parts of ${p.sku}`;

	const send = (list: Part[]) => () =>
		setProductParts({
			data: {
				productId: p.id,
				parts: list.map((c) => ({ productId: c.id, quantity: c.quantity })),
			},
		});

	function offerBack(message: string, before: Part[]) {
		offerUndo(message, {
			tone: "success",
			undo: async () => {
				const undone = await optimism.change({
					label,
					patch: partsPatch(p.id, before),
					send: send(before),
				});
				return undone && `${label} put back`;
			},
		});
	}

	async function save(next: Part[], message: string) {
		const before = parts;
		const r = await optimism.change({
			label,
			patch: partsPatch(p.id, next),
			send: send(next),
		});
		if (r) offerBack(message, before);
	}

	// Waits for the reload rather than guessing the new part's stock, so it
	// arrives with its real numbers.
	async function add(part: IndexedProduct) {
		const before = parts;
		setAdding(true);
		const r = await optimism.change({
			send: () =>
				setProductParts({
					data: {
						productId: p.id,
						parts: [
							...before.map((c) => ({ productId: c.id, quantity: c.quantity })),
							{ productId: part.id, quantity: 1 },
						],
					},
				}),
		});
		setAdding(false);
		if (!r) return;
		setFresh(part.sku);
		setTimeout(() => setFresh(null), 900);
		offerBack(`Added ${part.sku}`, before);
	}

	const kit = p.kind === "kit" && parts.length > 0;
	return (
		<Card
			title={p.kind === "bundle" ? "Parts in this set" : "Built from"}
			aside={
				kit && (
					<span className="flex gap-4">
						<button
							type="button"
							onClick={() => setConverting("disassemble")}
							className="text-link hover:underline"
						>
							Take apart
						</button>
						<button
							type="button"
							onClick={() => setConverting("assemble")}
							className="text-link hover:underline"
						>
							Assemble
						</button>
					</span>
				)
			}
			flush
		>
			{parts.length > 0 && (
				<table className="w-full">
					<thead>
						<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
							<th className="px-4 py-2 font-medium">Part</th>
							<th className="px-4 py-2 text-right font-medium">Needed</th>
							<th className="px-4 py-2 text-right font-medium">In stock</th>
							<th className="w-10" />
						</tr>
					</thead>
					<tbody>
						{parts.map((c) => {
							const short = c.available < c.quantity;
							return (
								<tr
									key={c.sku}
									className={cn(
										"group border-t transition-colors duration-700 first:border-t-0",
										fresh === c.sku && "bg-success-fill",
									)}
								>
									<td className="px-4 py-2.5">
										<Link
											to="/products/$sku"
											params={{ sku: c.sku }}
											className="block hover:underline"
										>
											<ProductName name={c.name} variantName={c.variantName} />
										</Link>
										<div className="text-xs text-muted-foreground">{c.sku}</div>
									</td>
									<td className="px-4 py-2.5 text-right">
										<QuantityInput
											sku={c.sku}
											value={c.quantity}
											onSave={(quantity) =>
												save(
													parts.map((x) =>
														x.id === c.id ? { ...x, quantity } : x,
													),
													`${formatCount(quantity)} × ${c.sku} in each`,
												)
											}
										/>
									</td>
									<td className="px-4 py-2.5 text-right">
										{short ? (
											<Badge tone="warning">
												Only {formatCount(c.available)}
											</Badge>
										) : limits(d, c) ? (
											<Tip content="Runs out first">
												<span className="font-semibold text-warning-text tabular-nums">
													{formatCount(c.available)}
												</span>
											</Tip>
										) : (
											<span className="tabular-nums">
												{formatCount(c.available)}
											</span>
										)}
									</td>
									<td className="pr-2">
										<RemoveButton
											last={parts.length === 1}
											sku={c.sku}
											onRemove={() =>
												save(
													parts.filter((x) => x.id !== c.id),
													`Took ${c.sku} out`,
												)
											}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
			<ProductSearch
				placeholder="Add a part: SKU or name"
				busy={adding}
				refuse={(x) => refusal(p, parts, x)}
				onPick={add}
				className={cn(parts.length > 0 && "border-t")}
			/>
			{kit && (
				<KitDialog
					direction={converting}
					onClose={() => setConverting(null)}
					d={d}
					kitPatch={kitPatch}
				/>
			)}
		</Card>
	);
}

// A kit or tool set needs a part, so the last one can't be taken out; it
// says so instead.
function RemoveButton({
	last,
	sku,
	onRemove,
}: {
	last: boolean;
	sku: string;
	onRemove: () => void;
}) {
	const button = (
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label={`Take ${sku} out`}
			disabled={last}
			onClick={onRemove}
			className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
		>
			<X />
		</Button>
	);
	return last ? (
		<Tip content="Needs at least one part">
			<span className="inline-flex">{button}</span>
		</Tip>
	) : (
		button
	);
}

// How many go in one, typed over. Enter or leaving keeps it; Escape, or
// anything that isn't a whole number over 0, puts it back.
function QuantityInput({
	sku,
	value,
	onSave,
}: {
	sku: string;
	value: number;
	onSave: (quantity: number) => void;
}) {
	const [text, setText] = useState(String(value));
	const [was, setWas] = useState(value);
	const ref = useRef<HTMLInputElement>(null);
	// A change from elsewhere (an undo, the reload) shows here.
	if (was !== value) {
		setWas(value);
		setText(String(value));
	}
	function commit() {
		const n = Number(text);
		if (n === value) return;
		if (!Number.isInteger(n) || n < 1) {
			setText(String(value));
			shake(ref.current);
			return;
		}
		onSave(n);
	}
	return (
		<input
			ref={ref}
			inputMode="numeric"
			value={text}
			aria-label={`How many ${sku} in one`}
			onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				else if (e.key === "Escape") {
					// Not the page's Escape, which goes back.
					e.preventDefault();
					setText(String(value));
					// Blurs after the reset lands, so nothing is saved.
					requestAnimationFrame(() => ref.current?.blur());
				}
			}}
			onBlur={commit}
			className="h-7 w-14 rounded-md border border-transparent bg-transparent px-1.5 text-right tabular-nums outline-none hover:border-input focus:border-ring focus:ring-1 focus:ring-ring"
		/>
	);
}
