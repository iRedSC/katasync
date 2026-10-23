import { ArrowRight } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { formatCount } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { type ProductDetail, undoMovement } from "#/server/catalog";
import { convertKits } from "#/server/catalog/product-edits";

export type KitDirection = "assemble" | "disassemble";

type Place = ProductDetail["locations"][number];

// How many kits one shelf can build from its parts, or has to take apart.
// The number can't go over it, so the server is never asked for what it
// would refuse.
function most(d: ProductDetail, direction: KitDirection, place: Place) {
	if (direction === "disassemble")
		return Math.max(
			0,
			d.stock.find((s) => s.location === place.name)?.onHand ?? 0,
		);
	return Math.min(
		...d.components.map((c) => {
			const onHand =
				c.shelves.find((s) => s.locationId === place.id)?.onHand ?? 0;
			return Math.max(0, Math.floor(onHand / c.quantity));
		}),
	);
}

// Builds kits from their parts on one shelf, or takes them apart back into
// them, then offers to undo it. With several of our locations, pick one.
export function KitDialog({
	direction,
	onClose,
	d,
	kitPatch,
}: {
	// Open while set.
	direction: KitDirection | null;
	onClose: () => void;
	d: ProductDetail;
	kitPatch: (location: Place, kits: number) => Patch;
}) {
	const p = d.product;
	const [placeId, setPlaceId] = useState(d.locations[0]?.id);
	const [quantity, setQuantity] = useState("");
	const place = d.locations.find((l) => l.id === placeId);
	const assemble = direction === "assemble";
	const max = direction && place ? most(d, direction, place) : 0;
	const value = quantity === "" ? null : Number(quantity);
	const valid = value !== null && value > 0 ? value : null;
	const over = valid !== null && valid > max;
	const ready = direction && place && valid !== null && !over;
	const kitsHere = d.stock.find((s) => s.location === place?.name)?.onHand ?? 0;

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!ready || !direction || !place || valid === null) return;
		const kits = assemble ? valid : -valid;
		const label = `${assemble ? "Assembling" : "Taking apart"} ${p.sku}`;
		onClose();
		setQuantity("");
		const r = await optimism.change({
			label,
			patch: kitPatch(place, kits),
			send: () =>
				convertKits({
					data: {
						productId: p.id,
						direction,
						quantity: valid,
						locationId: place.id,
					},
				}),
		});
		if (!r) return;
		const { batchId } = r.value;
		offerUndo(
			`${assemble ? "Assembled" : "Took apart"} ${formatCount(valid)} × ${p.sku}`,
			{
				tone: "success",
				undo: async () => {
					const undone = await optimism.change({
						label: `Undoing ${label.toLowerCase()}`,
						patch: kitPatch(place, -kits),
						send: () => undoMovement({ data: { batchId } }),
					});
					return undone && `${label} undone`;
				},
			},
		);
	}

	return (
		<Dialog
			open={direction !== null}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
					setQuantity("");
				}
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="flex flex-col gap-6">
					<DialogHeader>
						<DialogTitle>
							{assemble ? "Assemble kits" : "Take kits apart"}
						</DialogTitle>
						<DialogDescription className="truncate">
							{p.variantName ? `${p.name}, ${p.variantName}` : p.name}
						</DialogDescription>
					</DialogHeader>

					{d.locations.length > 1 && (
						<div className="flex flex-wrap items-center justify-center gap-2">
							{d.locations.map((l) => (
								<button
									key={l.id}
									type="button"
									onClick={() => setPlaceId(l.id)}
									className={cn(
										"h-7 rounded-lg px-3 font-medium transition-colors",
										l.id === placeId
											? "bg-primary text-primary-foreground"
											: "bg-surface hover:bg-surface-strong",
									)}
								>
									{l.name}
								</button>
							))}
						</div>
					)}

					<div className="flex flex-col items-center gap-2">
						<input
							autoFocus
							inputMode="numeric"
							value={quantity}
							onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))}
							placeholder="0"
							aria-label="How many kits"
							className={cn(
								"w-full bg-transparent text-center text-6xl font-semibold tabular-nums outline-none placeholder:text-muted-foreground/30",
								over && "text-critical-text",
							)}
						/>
						<p
							className={cn(
								"text-muted-foreground",
								over && "text-critical-text",
							)}
						>
							{max === 0 ? (
								assemble ? (
									"Not enough parts here"
								) : (
									"None here"
								)
							) : valid !== null && !over ? (
								<>
									{p.sku} {formatCount(kitsHere)}
									<ArrowRight className="mx-1 inline size-3.5" />
									{formatCount(kitsHere + (assemble ? valid : -valid))}
								</>
							) : (
								<button
									type="button"
									onClick={() => setQuantity(String(max))}
									className="hover:underline"
								>
									Up to {formatCount(max)}
								</button>
							)}
						</p>
					</div>

					<DialogFooter>
						<Button
							type="submit"
							size="lg"
							className="w-full"
							disabled={!ready}
						>
							{assemble ? "Assemble" : "Take apart"}
							{valid !== null && !over && ` ${formatCount(valid)}`}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
