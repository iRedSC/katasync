import { useState } from "react";
import { Card } from "#/components/page";
import { ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import { formatCount, formatDateTime } from "#/lib/format";
import type { Result } from "#/lib/optimism";
import { cn } from "#/lib/utils";
import type { getTransfer } from "#/server/transfers";

type Loaded = Awaited<ReturnType<typeof getTransfer>>;
type Delivery = Extract<Loaded["delivery"], { kind: "in_transit" | "received" }>;

export function Arrivals({
	delivery,
	lines,
	to,
	onReceive,
	onUndo,
}: {
	delivery: Delivery;
	lines: Loaded["lines"];
	to: string;
	onReceive: (
		counts: { productId: number; quantity: number }[],
	) => Promise<Result<unknown>>;
	onUndo: (receiptId: number) => Promise<Result<unknown>>;
}) {
	const open = delivery.lines.filter((l) => l.inTransit > 0);
	const [counts, setCounts] = useState<Record<number, string>>({});
	const countOf = (productId: number, inTransit: number) => {
		const text = counts[productId];
		const n = text === undefined ? inTransit : Number(text);
		return Number.isInteger(n) && n >= 0 && n <= inTransit ? n : null;
	};
	const parsed = open.map((l) => ({
		productId: l.productId,
		quantity: countOf(l.productId, l.inTransit),
	}));
	const valid = parsed.every((p) => p.quantity !== null);
	const total = parsed.reduce((n, p) => n + (p.quantity ?? 0), 0);
	const product = (id: number) => lines.find((l) => l.productId === id);
	return (
		<Card title={open.length > 0 ? `On the way to ${to}` : `Arrived at ${to}`} flush>
			{open.length > 0 && (
				<>
					<table className="w-full">
						<tbody>
							{open.map((l) => {
								const p = product(l.productId);
								const bad = countOf(l.productId, l.inTransit) === null;
								return (
									<tr key={l.productId} className="border-t">
										<td className="px-4 py-2">
											{p ? (
												<ProductName name={p.name} variantName={p.variantName} />
											) : (
												l.productId
											)}
										</td>
										<td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
											{formatCount(l.received)} of {formatCount(l.sent)}
										</td>
										<td className="w-24 px-4 py-2">
											<input
												inputMode="numeric"
												aria-label={`${p?.sku ?? l.productId} arrived`}
												value={counts[l.productId] ?? String(l.inTransit)}
												onChange={(e) =>
													setCounts({ ...counts, [l.productId]: e.target.value })
												}
												className={cn(
													"w-full rounded-lg bg-surface px-2 py-1 text-right tabular-nums outline-none",
													bad && "ring-2 ring-critical",
												)}
											/>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<div className="flex justify-end border-t px-4 py-3">
						<Button
							disabled={!valid || total === 0}
							onClick={async () => {
								const r = await onReceive(
									parsed.flatMap((p) =>
										p.quantity ? [{ productId: p.productId, quantity: p.quantity }] : [],
									),
								);
								if (r) setCounts({});
							}}
						>
							Receive {formatCount(total)} at {to}
						</Button>
					</div>
				</>
			)}
			{delivery.receipts.map((r) => (
				<div
					key={r.id}
					className={cn(
						"flex items-center gap-3 border-t px-4 py-2 text-sm",
						r.undone && "text-muted-foreground line-through",
					)}
				>
					<span className="tabular-nums">
						{formatCount(r.lines.reduce((n, l) => n + l.quantity, 0))} arrived
					</span>
					<span className="text-muted-foreground">{formatDateTime(r.createdAt)}</span>
					{!r.undone && (
						<button
							type="button"
							onClick={() => onUndo(r.id)}
							className="ml-auto rounded-lg px-2 py-1 text-muted-foreground hover:bg-surface-strong"
						>
							Undo
						</button>
					)}
				</div>
			))}
		</Card>
	);
}
