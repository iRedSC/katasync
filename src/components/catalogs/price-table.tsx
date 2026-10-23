import { Link } from "@tanstack/react-router";
import { PackageOpen, X } from "lucide-react";
import { toast } from "sonner";
import {
	type CatalogOffer,
	type CatalogProduct,
	patchCatalog,
} from "#/components/catalogs/data";
import { EmptyState } from "#/components/page";
import { ProductImage } from "#/components/product";
import { InlineField } from "#/components/purchase-order/inline-fields";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatMoney } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { useRowLink } from "#/lib/row-link";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import type { CatalogDetail } from "#/server/purchasing";
import {
	restoreProductCatalogs,
	setProductCatalog,
	setSupplierTerms,
} from "#/server/purchasing";

type Carrier = CatalogDetail["carriers"][number];

const title = (p: { name: string; variantName: string | null }) =>
	p.variantName ? `${p.name} ${p.variantName}` : p.name;

// Every product in the catalog against every supplier carrying it, so a
// row compares prices at a glance. Reorder buys from the green one. Prices
// change in place; a product leaves the catalog from its row, with Undo.
export function PriceTable({
	catalogId,
	carriers,
	products,
	soldDays,
}: {
	catalogId: number;
	carriers: Carrier[];
	products: CatalogProduct[];
	soldDays: number;
}) {
	if (products.length === 0)
		return (
			<EmptyState icon={PackageOpen} title="Nothing in it yet">
				Add products above, or tick them on the products list and use Add to
				catalog.
			</EmptyState>
		);
	return (
		<div className="overflow-x-auto">
			<table className="w-full">
				<thead>
					<tr className="border-b bg-subtle text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Product</th>
						<th className="px-3 py-2 text-right font-medium">On hand</th>
						<th className="hidden px-3 py-2 text-right font-medium md:table-cell">
							<Tip content={`Units sold in the last ${soldDays} days`}>
								<span>Sold {soldDays}d</span>
							</Tip>
						</th>
						{carriers.map((s) => (
							<th
								key={s.id}
								className="px-3 py-2 text-right font-medium whitespace-nowrap"
							>
								<Link
									to="/purchasing/suppliers/$id"
									params={{ id: String(s.id) }}
									className="hover:text-foreground hover:underline"
								>
									{s.name}
								</Link>
							</th>
						))}
						<th className="w-8" />
					</tr>
				</thead>
				<tbody>
					{products.map((p) => (
						<ProductLine
							key={p.id}
							catalogId={catalogId}
							product={p}
							carriers={carriers}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

function ProductLine({
	catalogId,
	product: p,
	carriers,
}: {
	catalogId: number;
	product: CatalogProduct;
	carriers: Carrier[];
}) {
	const { link } = useRowLink();
	return (
		<tr
			{...link({ to: "/products/$sku", params: { sku: p.sku } })}
			className="group cursor-pointer border-t first:border-t-0 hover:bg-subtle"
		>
			<td className="w-full max-w-0 min-w-56 px-4 py-2">
				<div className="flex items-center gap-2.5">
					<ProductImage src={p.imageUrl} className="size-9" />
					<div className="min-w-0">
						<div className="truncate font-medium">{title(p)}</div>
						<div className="truncate text-xs text-muted-foreground">
							{p.sku}
							{p.kind === "bundle" && " · tool set, bought as its parts"}
							{p.archived && " · archived"}
						</div>
					</div>
				</div>
			</td>
			<td className="px-3 py-2 text-right tabular-nums">
				{p.onHand === null ? (
					<span className="text-faint">n/a</span>
				) : (
					formatCount(p.onHand)
				)}
			</td>
			<td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">
				{p.sold > 0 ? (
					formatCount(p.sold)
				) : (
					<span className="text-faint">0</span>
				)}
			</td>
			{carriers.map((s) => (
				<PriceCell
					key={s.id}
					catalogId={catalogId}
					product={p}
					supplier={s}
					offer={p.offers.find((o) => o.supplierId === s.id) ?? null}
					compared={carriers.length > 1}
				/>
			))}
			<td className="pr-2">
				<button
					type="button"
					aria-label={`Take ${p.sku} out of the catalog`}
					onClick={() => takeOut(catalogId, p)}
					className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-surface-strong hover:text-critical-text focus-visible:opacity-100"
				>
					<X className="size-4" />
				</button>
			</td>
		</tr>
	);
}

// One supplier's price for one product, per their unit, with what one item
// works out to when they sell in packs.
function PriceCell({
	catalogId,
	product: p,
	supplier: s,
	offer: o,
	compared,
}: {
	catalogId: number;
	product: CatalogProduct;
	supplier: Carrier;
	offer: CatalogOffer | null;
	compared: boolean;
}) {
	// Tool sets have no offers: they're bought as their parts.
	if (!o)
		return (
			<td className="px-3 py-2 text-right text-faint">
				{p.kind === "bundle" ? "" : "n/a"}
			</td>
		);
	const best = o.cheapest && compared && o.cost !== null;
	return (
		<td
			className={cn(
				"px-3 py-1 text-right whitespace-nowrap",
				best && "bg-success-surface",
			)}
		>
			<div className="flex justify-end">
				<InlineField
					shown={formatMoney(o.cost)}
					initial={o.cost === null ? "" : String(o.cost)}
					placeholder="Add price"
					label={`${s.name}'s price for ${p.sku}`}
					inputMode="decimal"
					align="right"
					className="w-24"
					onSave={async (text) => {
						const cost = text === "" ? null : Number(text);
						if (cost !== null && !(Number.isFinite(cost) && cost >= 0)) {
							toast.error(`"${text}" isn't a price`);
							return false;
						}
						const r = await optimism.change({
							label: `${s.name}'s price for ${p.sku}`,
							patch: patchCatalog(catalogId, (d) => ({
								...d,
								products: d.products.map((x) =>
									x.id !== p.id
										? x
										: {
												...x,
												offers: x.offers.map((y) =>
													y.supplierId !== s.id
														? y
														: {
																...y,
																cost,
																itemCost:
																	cost === null ? null : cost / y.packSize,
															},
												),
											},
								),
							})),
							send: () =>
								setSupplierTerms({
									data: { productId: p.id, supplierId: s.id, cost },
								}),
						});
						return r !== null;
					}}
				/>
			</div>
			<div className="pr-1.5 text-xs text-muted-foreground">
				{[
					o.supplierSku,
					o.packSize > 1 && `${o.unit} of ${o.packSize}`,
					o.packSize > 1 &&
						o.itemCost !== null &&
						`${formatMoney(o.itemCost)} each`,
				]
					.filter(Boolean)
					.join(" · ")}
			</div>
		</td>
	);
}

// Takes a product out of the catalog, so nobody sells it until it's in
// another. Undo puts it back, every supplier's terms included.
async function takeOut(catalogId: number, p: CatalogProduct) {
	const r = await optimism.change({
		label: `Taking ${p.sku} out`,
		patch: patchCatalog(catalogId, (d) => ({
			...d,
			products: d.products.filter((x) => x.id !== p.id),
		})),
		send: () =>
			setProductCatalog({ data: { productIds: [p.id], catalogId: null } }),
	});
	if (!r) return;
	offerUndo(`${p.sku} is in no catalog now`, {
		undo: async () => {
			const back = await optimism.change({
				label: `Putting ${p.sku} back`,
				patch: patchCatalog(catalogId, (d) => ({
					...d,
					products: [...d.products, p].sort((a, b) =>
						title(a).localeCompare(title(b)),
					),
				})),
				send: () => restoreProductCatalogs({ data: { before: r.value } }),
			});
			return back && `Put ${p.sku} back`;
		},
	});
}
