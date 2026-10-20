import { ArrowLeftRight, ArrowRight } from "lucide-react";
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
import { recordTransfer, undoMovement } from "#/server/catalog";

type Place = { id: number; name: string };

// Moves stock from one of our shelves to another, e.g. restocking the
// retail store from the warehouse. With two locations it's one direction you
// can flip; with more, pick both ends. `patch` says how the move shows on the
// page and what undoing it shows, so the dialog closes at once.
export function TransferDialog({
	open,
	onOpenChange,
	sku,
	name,
	locations,
	onHandByLocation,
	patch,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sku: string;
	name: string;
	locations: Place[];
	onHandByLocation: Map<string, number>;
	patch: (move: { from: string; to: string; quantity: number }) => {
		patch: Patch;
		undo: Patch;
	};
}) {
	const [fromId, setFromId] = useState<number | undefined>(locations[0]?.id);
	const [toId, setToId] = useState<number | undefined>(locations[1]?.id);
	const [quantity, setQuantity] = useState("");
	const from = locations.find((l) => l.id === fromId);
	const to = locations.find((l) => l.id === toId);
	const has = (l: Place | undefined) =>
		onHandByLocation.get(l?.name ?? "") ?? 0;
	const value = quantity === "" ? null : Number(quantity);
	const valid =
		value !== null && Number.isInteger(value) && value > 0 ? value : null;
	const short = valid !== null && valid > has(from);
	const ready = from && to && from.id !== to.id && valid !== null && !short;

	const label = `Move of ${name}`;
	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!ready || !from || !to || valid === null) return;
		const laid = patch({ from: from.name, to: to.name, quantity: valid });
		onOpenChange(false);
		setQuantity("");
		const r = await optimism.change({
			label,
			patch: laid.patch,
			send: () =>
				recordTransfer({
					data: {
						sku,
						fromLocationId: from.id,
						toLocationId: to.id,
						quantity: valid,
					},
				}),
		});
		if (!r) return;
		const { batchId } = r.value;
		offerUndo(`Moved ${formatCount(valid)} to ${to.name}`, {
			tone: "success",
			description: name,
			undo: async () => {
				const undone = await optimism.change({
					label: `Undoing the ${label.toLowerCase()}`,
					patch: laid.undo,
					send: () => undoMovement({ data: { batchId } }),
				});
				return undone && `${label} undone`;
			},
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="flex flex-col gap-6">
					<DialogHeader>
						<DialogTitle>Move stock</DialogTitle>
						<DialogDescription className="truncate">{name}</DialogDescription>
					</DialogHeader>

					{locations.length === 2 ? (
						<div className="flex items-center justify-center gap-3">
							<End place={from} onHand={has(from)} />
							<button
								type="button"
								aria-label="Swap direction"
								onClick={() => {
									setFromId(toId);
									setToId(fromId);
								}}
								className="rounded-lg p-2 hover:bg-surface-strong"
							>
								<ArrowLeftRight className="size-4" />
							</button>
							<End place={to} onHand={has(to)} />
						</div>
					) : (
						<div className="flex flex-col gap-3">
							<Picker
								label="From"
								locations={locations}
								active={fromId}
								onPick={(id) => {
									setFromId(id);
									if (id === toId)
										setToId(locations.find((l) => l.id !== id)?.id);
								}}
							/>
							<Picker
								label="To"
								locations={locations.filter((l) => l.id !== fromId)}
								active={toId}
								onPick={setToId}
							/>
						</div>
					)}

					<div className="flex flex-col items-center gap-2">
						<input
							autoFocus
							inputMode="numeric"
							value={quantity}
							onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))}
							placeholder="0"
							className="w-full bg-transparent text-center text-6xl font-semibold tabular-nums outline-none placeholder:text-muted-foreground/30"
						/>
						<p
							className={cn(
								"text-muted-foreground",
								short && "text-critical-text",
							)}
						>
							{short ? (
								<>
									{from?.name} has only {formatCount(has(from))}. Count it there
									if that's wrong.
								</>
							) : valid !== null && from && to ? (
								<>
									{from.name} {formatCount(has(from))}
									<ArrowRight className="mx-1 inline size-3.5" />
									{formatCount(has(from) - valid)}, {to.name}{" "}
									{formatCount(has(to))}
									<ArrowRight className="mx-1 inline size-3.5" />
									{formatCount(has(to) + valid)}
								</>
							) : (
								<>How many are going?</>
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
							{to ? `Move to ${to.name}` : "Move"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function End({ place, onHand }: { place: Place | undefined; onHand: number }) {
	return (
		<div className="min-w-24 text-center">
			<div className="font-medium">{place?.name}</div>
			<div className="text-xs text-muted-foreground tabular-nums">
				{formatCount(onHand)} on hand
			</div>
		</div>
	);
}

function Picker({
	label,
	locations,
	active,
	onPick,
}: {
	label: string;
	locations: Place[];
	active: number | undefined;
	onPick: (id: number) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="w-10 text-muted-foreground">{label}</span>
			{locations.map((l) => (
				<button
					key={l.id}
					type="button"
					onClick={() => onPick(l.id)}
					className={cn(
						"h-7 rounded-lg px-3 font-medium transition-colors",
						l.id === active
							? "bg-primary text-primary-foreground"
							: "bg-surface hover:bg-surface-strong",
					)}
				>
					{l.name}
				</button>
			))}
		</div>
	);
}
