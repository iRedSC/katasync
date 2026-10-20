import { Card } from "#/components/page";
import { ProductImage, ProductName } from "#/components/product";
import { Button } from "#/components/ui/button";
import type { RefillRow } from "#/inventory/refill";
import { formatCount } from "#/lib/format";

// Products below their target at the destination that aren't on the draft
// yet, with what tops each one up as far as the source has it.
export function Suggestions({
	rows,
	to,
	onAdd,
	onAddAll,
}: {
	rows: RefillRow[];
	to: string;
	onAdd: (row: RefillRow) => void;
	onAddAll: () => void;
}) {
	return (
		<Card
			title={`${formatCount(rows.length)} below target at ${to}`}
			aside={
				<button
					type="button"
					onClick={onAddAll}
					className="text-link hover:underline"
				>
					Add all
				</button>
			}
			flush
		>
			<table className="w-full">
				<thead>
					<tr className="border-y bg-subtle text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Product</th>
						<th className="px-4 py-2 text-right font-medium">At {to}</th>
						<th className="px-4 py-2 text-right font-medium">Target</th>
						<th className="px-4 py-2 text-right font-medium">Send</th>
						<th className="w-20" />
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.productId} className="border-t">
							<td className="px-4 py-2">
								<div className="flex items-center gap-3">
									<ProductImage src={r.imageUrl} className="size-8" />
									<div className="min-w-0">
										<ProductName name={r.name} variantName={r.variantName} />
										<div className="text-xs text-muted-foreground">{r.sku}</div>
									</div>
								</div>
							</td>
							<td className="px-4 py-2 text-right tabular-nums">
								{formatCount(r.atDestination)}
							</td>
							<td className="px-4 py-2 text-right tabular-nums">
								{formatCount(r.target)}
							</td>
							<td className="px-4 py-2 text-right font-semibold tabular-nums">
								{formatCount(r.suggested)}
							</td>
							<td className="pr-3 text-right">
								<Button size="sm" variant="outline" onClick={() => onAdd(r)}>
									Add
								</Button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	);
}
