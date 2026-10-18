import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AbcBadge, Card } from "#/components/page";
import { ProductImage, ProductName, SetsChip } from "#/components/product";
import {
	Inventory,
	Reorder,
	RowStatus,
} from "#/components/products-list/row-cells";
import { RowMenu } from "#/components/products-list/row-menu";
import { StockCard } from "#/components/stock-card";
import { ContextMenu, ContextMenuTrigger } from "#/components/ui/context-menu";
import { Tip } from "#/components/ui/tooltip";
import { VelocityGauge } from "#/components/velocity-gauge";
import { formatCount } from "#/lib/format";
import { useRowLink } from "#/lib/row-link";
import type { stateOf } from "#/products/rows";
import type { ProductRow } from "#/server/catalog";

// The list's rows as a table or as cards. Owns which row's right-click menu is open.
export function ProductResults({
	layout,
	products,
	stateFor,
	now,
	adding,
	onAddToPo,
	onCount,
}: {
	layout: "table" | undefined;
	products: ProductRow[];
	stateFor: (p: ProductRow) => ReturnType<typeof stateOf>;
	now: Date;
	adding: ReadonlySet<number>;
	onAddToPo: (p: ProductRow) => void;
	onCount: (p: ProductRow) => void;
}) {
	const navigate = useNavigate();
	const { link } = useRowLink();
	const to = (p: ProductRow) =>
		({ to: "/products/$sku", params: { sku: p.sku } }) as const;
	const open = (p: ProductRow) => navigate(to(p));
	// The product the right-click menu acts on.
	const [menuFor, setMenuFor] = useState<ProductRow | null>(null);

	return layout === "table" ? (
		<Card flush>
			<table className="w-full">
				<thead>
					<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Product</th>
						<th className="px-2 py-2 text-center font-medium">Class</th>
						<th className="hidden px-4 py-2 font-medium md:table-cell">
							Status
						</th>
						<th className="px-4 py-2 font-medium">Inventory</th>
						<th className="hidden px-4 py-2 text-right font-medium xl:table-cell">
							On order
						</th>
						<Tip content="Units sold a month">
							<th className="hidden px-2 py-2 text-center font-medium md:table-cell">
								Velocity
							</th>
						</Tip>
						<th className="hidden px-4 py-2 font-medium md:table-cell">
							Reorder
						</th>
						<th className="hidden px-4 py-2 font-medium 2xl:table-cell">
							Type
						</th>
					</tr>
				</thead>
				{/* One menu for the whole list: it acts on the row that was
		    right-clicked. */}
				<ContextMenu>
					<ContextMenuTrigger asChild>
						<tbody>
							{products.map((p) => (
								<tr
									key={p.id}
									{...link(to(p))}
									onContextMenu={() => setMenuFor(p)}
									className="cursor-pointer border-t first:border-t-0 hover:bg-subtle"
								>
									{/* Takes the width the other columns leave, so long names end
				    in "…" instead of pushing them off the card. */}
									<td className="w-full max-w-0 px-4 py-2">
										<div className="flex items-center gap-3">
											<ProductImage src={p.imageUrl} />
											<div className="min-w-0 flex-1">
												<ProductName
													name={p.name}
													variantName={p.variantName}
												/>
												<div className="flex items-center gap-2 text-xs text-muted-foreground">
													<span>{p.sku}</span>
													<SetsChip sets={p.why?.sets ?? null} />
													{p.kind === "bundle" && <span>Tool set</span>}
													{p.kind === "kit" && <span>Kit</span>}
												</div>
											</div>
										</div>
									</td>
									<td className="px-2 py-2 text-center">
										<AbcBadge
											abc={p.abc}
											title={
												p.abcRank === null
													? "Needs a cost"
													: p.kind === "bundle"
														? `#${formatCount(p.abcRank)} of tool sets by value`
														: `#${formatCount(p.abcRank)} by value`
											}
										/>
									</td>
									<td className="hidden px-4 py-2 whitespace-nowrap md:table-cell">
										<RowStatus product={p} />
									</td>
									<td className="px-4 py-2 whitespace-nowrap">
										<Inventory product={p} />
									</td>
									<td className="hidden px-4 py-2 text-right whitespace-nowrap tabular-nums xl:table-cell">
										{p.onOrder > 0 ? formatCount(p.onOrder) : ""}
									</td>
									<td className="hidden px-2 py-1.5 md:table-cell">
										<VelocityGauge why={p.why} onPo={p.draft ?? undefined} />
									</td>
									<td className="hidden px-4 py-2 whitespace-nowrap md:table-cell">
										<Reorder product={p} />
									</td>
									<td className="hidden px-4 py-2 whitespace-nowrap text-muted-foreground 2xl:table-cell">
										{p.category ?? ""}
									</td>
								</tr>
							))}
						</tbody>
					</ContextMenuTrigger>
					{menuFor && (
						<RowMenu
							product={menuFor}
							onOpen={open}
							onAddToPo={onAddToPo}
							adding={adding}
							onCount={onCount}
						/>
					)}
				</ContextMenu>
			</table>
		</Card>
	) : (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
					{products.map((p) => (
						<StockCard
							key={p.id}
							product={p}
							state={stateFor(p)}
							now={now}
							link={link(to(p))}
							onMenu={() => setMenuFor(p)}
							busy={adding.has(p.id)}
							onOrder={() => onAddToPo(p)}
							onCount={() => onCount(p)}
						/>
					))}
				</div>
			</ContextMenuTrigger>
			{menuFor && (
				<RowMenu
					product={menuFor}
					onOpen={open}
					onAddToPo={onAddToPo}
					adding={adding}
					onCount={onCount}
				/>
			)}
		</ContextMenu>
	);
}
