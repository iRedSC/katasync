import { Link } from "@tanstack/react-router";
import { BulkChip } from "#/components/bulk-chip";
import { OnPoChip } from "#/components/on-po-chip";
import { Badge, Card } from "#/components/page";
import { ProductImage, SetsChip } from "#/components/product";
import { PurchaseUnitCell } from "#/components/purchase-unit";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import { VelocityGauge } from "#/components/velocity-gauge";
import { formatCount, formatMoney } from "#/lib/format";
import { ids } from "#/lib/optimism";
import { orderedItems } from "#/purchasing/sets";
import { addRecommended, type PurchaseOrderDetail } from "#/server/purchasing";
import { AfterPo } from "./after-po";
import { recommendedLine } from "./new-lines";
import { poData } from "./po-data";
import type { Recommendation } from "./types";
import { useAction } from "./use-action";

// Under a draft's lines: this supplier's products worth adding, filled to
// their max. First what needs ordering now but the PO doesn't take by itself
// (C items, and what another supplier sells for less, flagged with who and
// how much), then what will need ordering before its next PO would. Says how far short of the supplier's minimum the
// draft is, since these are what fill it.
export function Recommended({
	detail: d,
	total,
}: {
	detail: PurchaseOrderDetail;
	total: number;
}) {
	const { save } = useAction();
	const short = d.supplier.minimumOrder - total;
	// What the draft already orders of each product, e.g. as a set's part,
	// so After PO counts it alongside the recommendation.
	const items = orderedItems(d.lines, d.setParts, d.supplier.id);

	// The line shows at once, as the server will make it, under an id of its
	// own until the server's comes back.
	function add(r: Recommendation) {
		const id = ids.provisional();
		const line = recommendedLine(r, id, d.supplier.id);
		save({
			label: `Adding ${r.sku}`,
			patch: poData.patch(d.order.id, (data) => ({
				...data,
				// A suggested PO's first change saves it as a draft.
				order:
					data.order.status === "suggested"
						? { ...data.order, status: "draft" }
						: data.order,
				lines: data.lines.some((l) => l.productId === r.productId)
					? data.lines
					: [...data.lines, line],
				recommended: data.recommended.filter(
					(x) => x.productId !== r.productId,
				),
			})),
			send: async () => {
				const res = await addRecommended({
					data: {
						purchaseOrderId: d.order.id,
						productId: r.productId,
						quantity: r.quantity,
					},
				});
				ids.confirm(id, res.line.id);
				return res;
			},
			success: (res) =>
				res.added ? `Added ${r.sku}` : `${r.sku} is already on this PO`,
		});
	}
	return (
		<Card
			flush
			title="Recommended additions"
			aside={short > 0 ? `${formatMoney(short)} short` : undefined}
		>
			{d.recommended.length === 0 ? (
				<p className="px-4 py-6 text-center text-muted-foreground">
					Nothing to add.
				</p>
			) : (
				<div className="overflow-x-auto">
					{/* Laid out like the draft's lines above, read-only until added. */}
					<table className="w-full [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
						<thead>
							<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
								<th className="px-4 py-2 font-medium">Product</th>
								<th className="px-3 py-2 font-medium">Their SKU</th>
								<th className="px-3 py-2 font-medium">MOQ / UOM</th>
								<th className="px-3 py-2 font-medium">Due</th>
								<th className="px-3 py-2 text-right font-medium">Qty</th>
								<th className="px-3 py-2 text-center font-medium">
									On hand → After PO
								</th>
								<Tip content="Units sold a month">
									<th className="px-3 py-2 text-center font-medium">
										Velocity
									</th>
								</Tip>
								<th className="px-3 py-2 text-right font-medium">Cost</th>
								<th className="px-3 py-2 text-right font-medium">Amount</th>
								<th className="px-4 py-2" />
							</tr>
						</thead>
						<tbody>
							{d.recommended.map((r) => (
								<tr key={r.productId} className="border-t first:border-t-0">
									<td className="w-full px-4 py-2 whitespace-normal!">
										<div className="flex min-w-72 items-center gap-3">
											<ProductImage src={r.imageUrl} />
											<div className="min-w-0">
												<Link
													to="/products/$sku"
													params={{ sku: r.sku }}
													className="block hover:underline"
												>
													<span className="line-clamp-2 font-medium">
														{r.name}
														{r.variantName && (
															<span className="ml-1.5 rounded-md bg-surface px-1.5 text-xs font-normal text-muted-foreground">
																{r.variantName}
															</span>
														)}
													</span>
												</Link>
												<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
													{r.sku}
													<OnPoChip pos={r.otherPos} />
													<SetsChip sets={r.why.sets} />
													{r.bulk && (
														<BulkChip list={r.bulk} unit={r.unit} order={r} />
													)}
													{r.critical && <Badge tone="info">Essential</Badge>}
													{r.cheaperAt && <CheaperAt at={r.cheaperAt} />}
												</div>
											</div>
										</div>
									</td>
									<td className="px-3 py-2">
										<span className="px-1.5 text-muted-foreground">
											{r.supplierSku ?? "—"}
										</span>
									</td>
									<td className="px-3 py-2">
										<PurchaseUnitCell
											label={r.sku}
											value={r}
											cost={r.unitCost}
										/>
									</td>
									<td className="px-3 py-2 text-muted-foreground">
										{r.due === "now" ? (
											<Badge tone="warning">Due</Badge>
										) : r.due === 0 ? (
											"Today"
										) : (
											`${formatCount(r.due)}d`
										)}
									</td>
									<td className="px-3 py-2 text-right font-semibold tabular-nums">
										{formatCount(r.quantity)}
									</td>
									<td className="px-3 py-2">
										{r.kind === "bundle" ? (
											<span className="block text-center text-muted-foreground">
												—
											</span>
										) : (
											<AfterPo
												onHand={r.onHand}
												range={r.stockRange}
												ordered={
													(items.get(r.productId) ?? 0) +
													r.quantity * r.packSize
												}
											/>
										)}
									</td>
									<td className="px-3 py-2">
										<VelocityGauge why={r.why} />
									</td>
									<td className="px-3 py-2 text-right tabular-nums">
										{r.kind === "bundle" ? (
											<span className="text-muted-foreground">As parts</span>
										) : (
											formatMoney(r.unitCost)
										)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums">
										{r.unitCost === null
											? "—"
											: formatMoney(r.unitCost * r.quantity)}
									</td>
									<td className="px-4 py-2 text-right">
										<Button size="sm" variant="outline" onClick={() => add(r)}>
											Add
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}

// Another supplier sells it for less, so suggestions put it on theirs. Says
// who and by how much a piece, so adding it here is a choice made knowingly.
function CheaperAt({ at }: { at: NonNullable<Recommendation["cheaperAt"]> }) {
	const saved = at.ours === null ? null : at.ours - at.itemCost;
	return (
		<Tip
			content={`${formatMoney(at.itemCost)} each at ${at.supplierName}${at.ours === null ? "" : `, ${formatMoney(at.ours)} here`}`}
		>
			<span className="inline-flex">
				<Badge tone="warning">
					{saved === null
						? `Priced at ${at.supplierCode}`
						: `${formatMoney(saved)} less at ${at.supplierCode}`}
				</Badge>
			</span>
		</Tip>
	);
}
