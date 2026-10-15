import { useRouter } from "@tanstack/react-router";
import { Minus, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
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
import { receiveOrderReturn, undoOrderReturn } from "#/server/orders";

type ReturnLine = {
	id: number;
	title: string;
	sku: string | null;
	imageUrl: string | null;
	// What can still come back: sold minus already returned.
	left: number;
};

// What came back in the box, line by line. Starts at everything still
// returnable, since most returns are the whole order; Enter puts it all
// back on the shelf.
export function ReturnDialog({
	open,
	onOpenChange,
	orderId,
	orderName,
	lines,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	orderId: number;
	orderName: string;
	lines: ReturnLine[];
}) {
	const router = useRouter();
	const [counts, setCounts] = useState(
		() => new Map(lines.map((l) => [l.id, l.left])),
	);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

	const set = (line: ReturnLine, n: number) =>
		setCounts(
			new Map(counts).set(line.id, Math.max(0, Math.min(line.left, n))),
		);

	async function receive(restock: boolean) {
		setSaving(true);
		setError(null);
		try {
			const { ids } = await receiveOrderReturn({
				data: {
					orderId,
					lines: [...counts].map(([lineId, quantity]) => ({
						lineId,
						quantity,
					})),
					restock,
				},
			});
			onOpenChange(false);
			await router.invalidate();
			toast.success(
				restock
					? `${formatCount(total)} back on the shelf`
					: `${formatCount(total)} written off as damaged`,
				{
					description: `Return on ${orderName}`,
					duration: 10_000,
					action: {
						label: "Undo",
						onClick: async () => {
							await undoOrderReturn({ data: { ids } });
							await router.invalidate();
							toast("Return undone", { description: orderName });
						},
					},
				},
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		receive(true);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-6">
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

					{error && <p className="text-center text-critical-text">{error}</p>}
					<DialogFooter className="gap-2 sm:justify-between">
						<Button
							type="button"
							variant="outline"
							disabled={total === 0 || saving}
							onClick={() => receive(false)}
						>
							Damaged, write off
						</Button>
						<Button type="submit" disabled={total === 0 || saving}>
							Put {formatCount(total)} back on shelf
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
