import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, Page } from "#/components/page";
import { ProductImage } from "#/components/product";
import {
	formatCount,
	formatDateTime,
	formatDelta,
	formatReason,
} from "#/lib/format";
import { cn } from "#/lib/utils";
import { listMovementBatches } from "#/server/catalog";

export const Route = createFileRoute("/stock")({
	loader: () => listMovementBatches(),
	component: InventoryHistory,
});

function InventoryHistory() {
	const batches = Route.useLoaderData();
	return (
		<Page title="Inventory history">
			<p className="-mt-2 text-muted-foreground">
				Every change to stock, newest first. Mistakes are fixed with a new
				entry, never by editing an old one.
			</p>
			<Card flush>
				<table className="w-full">
					<thead>
						<tr className="border-b bg-[#f7f7f7] text-left text-xs text-muted-foreground">
							<th className="px-4 py-2 font-medium">Change</th>
							<th className="hidden px-4 py-2 font-medium md:table-cell">
								Date
							</th>
							<th className="px-4 py-2 text-right font-medium">Units</th>
						</tr>
					</thead>
					<tbody>
						{batches.map((b) => {
							const single = b.lines === 1;
							const what = b.reasons.map(formatReason).join(" and ");
							const detail = [
								single ? what : null,
								b.note ?? (single ? null : b.reference),
							]
								.filter(Boolean)
								.join(", ");
							return (
								<tr
									key={b.batchId}
									className="border-t first:border-t-0 hover:bg-[#f7f7f7]"
								>
									<td className="px-4 py-2.5">
										<div className="flex items-center gap-3">
											{single ? (
												<ProductImage src={b.imageUrl} className="size-9" />
											) : (
												<div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-[#f7f7f7] text-xs font-semibold tabular-nums">
													{b.lines > 999
														? `${Math.round(b.lines / 1000)}k`
														: b.lines}
												</div>
											)}
											<div className="min-w-0">
												{single ? (
													<Link
														to="/products/$sku"
														params={{ sku: b.sku }}
														className="block truncate font-medium hover:underline"
													>
														{b.name}
													</Link>
												) : (
													<div className="font-medium">
														{what} for {formatCount(b.lines)} products
													</div>
												)}
												{detail && (
													<div className="truncate text-xs text-muted-foreground">
														{detail}
													</div>
												)}
											</div>
										</div>
									</td>
									<td className="hidden px-4 py-2.5 whitespace-nowrap text-muted-foreground md:table-cell">
										{formatDateTime(b.createdAt)}
									</td>
									<td
										className={cn(
											"px-4 py-2.5 text-right font-semibold tabular-nums",
											b.delta < 0 ? "text-critical-text" : "text-success-text",
										)}
									>
										{formatDelta(b.delta)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</Card>
		</Page>
	);
}
