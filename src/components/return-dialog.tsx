import { Minus, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ProductImage } from "#/components/product";
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
import { receiveOrderReturn, undoOrderReturn } from "#/server/orders";

type ReturnLine = {
	id: number;
	title: string;
	sku: string | null;
	imageUrl: string | null;
	// What can still come back: sold minus already returned.
	left: number;
	// What the counts start at, when not everything left is expected.
	start?: number;
};

export type Received = { lineId: number; quantity: number };

// What came back in the box, line by line. Starts at everything still
// returnable (or what's expected), since most returns are the whole order; Enter puts it all
// back on the shelf. It closes at once: the page shows the return before the
// server has it, and a failure says why in a toast.
export function ReturnDialog({
	open,
	onOpenChange,
	orderId,
	orderName,
	lines,
	patches,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	orderId: number;
	orderName: string;
	lines: ReturnLine[];
	// The page's data with a return laid over it, and with it taken off again
	// for Undo.
	patches: {
		receive: (received: Received[], restock: boolean) => Patch;
		undo: (received: Received[], restock: boolean) => Patch;
	};
}) {
	const [counts, setCounts] = useState(
		() =>
			new Map(lines.map((l) => [l.id, Math.min(l.start ?? l.left, l.left)])),
	);
	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

	const set = (line: ReturnLine, n: number) =>
		setCounts(
			new Map(counts).set(line.id, Math.max(0, Math.min(line.left, n))),
		);

	function receive(restock: boolean) {
		const received = [...counts].map(([lineId, quantity]) => ({
			lineId,
			quantity,
		}));
		onOpenChange(false);
		record(received, restock);
	}

	async function record(received: Received[], restock: boolean) {
		const count = received.reduce((sum, l) => sum + l.quantity, 0);
		const r = await optimism.change({
			label: `Return on ${orderName}`,
			patch: patches.receive(received, restock),
			send: () =>
				receiveOrderReturn({ data: { orderId, lines: received, restock } }),
		});
		if (!r) return;
		offerUndo(
			restock
				? `${formatCount(count)} back on the shelf`
				: `${formatCount(count)} written off as damaged`,
			{
				tone: "success",
				description: `Return on ${orderName}`,
				undo: async () => {
					const undone = await optimism.change({
						label: `Undoing return on ${orderName}`,
						patch: patches.undo(received, restock),
						send: () => undoOrderReturn({ data: { ids: r.value.ids } }),
					});
					return undone && `Return on ${orderName} undone`;
				},
			},
		);
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		receive(true);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
					<DialogHeader>
						<DialogTitle>What came back?</DialogTitle>
						<DialogDescription>Return on {orderName}</DialogDescription>
					</DialogHeader>

					<ul className="flex flex-col gap-3">
						{lines.map((l) => {
							const n = counts.get(l.id) ?? 0;
							return (
								<li key={l.id} className="flex items-center gap-3">
									<ProductImage src={l.imageUrl} className="size-10" />
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium">{l.title}</div>
										<div className="text-xs text-muted-foreground">
											{l.sku ?? "No SKU"}
										</div>
									</div>
									<div className="flex items-center gap-1">
										<Button
											type="button"
											size="icon"
											variant="outline"
											aria-label={`One fewer ${l.title}`}
											disabled={n === 0}
											onClick={() => set(l, n - 1)}
										>
											<Minus />
										</Button>
										<span className="w-16 text-center text-2xl font-semibold tabular-nums">
											{n}
											<span className="text-sm font-normal text-muted-foreground">
												{" "}
												/ {l.left}
											</span>
										</span>
										<Button
											type="button"
											size="icon"
											variant="outline"
											aria-label={`One more ${l.title}`}
											disabled={n === l.left}
											onClick={() => set(l, n + 1)}
										>
											<Plus />
										</Button>
									</div>
								</li>
							);
						})}
					</ul>

					<DialogFooter className="gap-2 sm:justify-between">
						<Button
							type="button"
							variant="outline"
							disabled={total === 0}
							onClick={() => receive(false)}
						>
							Damaged, write off
						</Button>
						<Button type="submit" disabled={total === 0}>
							Put {formatCount(total)} back on shelf
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
