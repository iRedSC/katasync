import { Link, useNavigate } from "@tanstack/react-router";
import {
	Ban,
	Copy,
	ExternalLink,
	FileText,
	PackageOpen,
	PackageX,
	Undo2,
	X,
} from "lucide-react";
import { toast } from "sonner";
import { BulkPrices } from "#/components/catalogs/bulk-prices";
import {
	type CatalogOffer,
	type CatalogProduct,
	patchCatalog,
} from "#/components/catalogs/data";
import { EmptyState } from "#/components/page";
import { ProductImage } from "#/components/product";
import { InlineField } from "#/components/purchase-order/inline-fields";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { Tip } from "#/components/ui/tooltip";
import { copyText } from "#/lib/copy";
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
	setSupplierUnavailable,
} from "#/server/purchasing";

type Carrier = CatalogDetail["carriers"][number];

const title = (p: { name: string; variantName: string | null }) =>
	p.variantName ? `${p.name} ${p.variantName}` : p.name;

// Every product in the catalog against every supplier carrying it, so a
// row compares prices at a glance. Reorder buys from the green one. Prices
// change in place; a product leaves the catalog from its row, with Undo, and
// its right-click menu marks it unavailable from a supplier, or back again.
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
								className="px-4 py-2 text-right font-medium whitespace-nowrap"
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
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<tr
					{...link({ to: "/products/$sku", params: { sku: p.sku } })}
					className="group cursor-pointer border-t first:border-t-0 hover:bg-subtle data-[state=open]:bg-subtle"
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
							unavailable={p.unavailable.includes(s.id)}
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
			</ContextMenuTrigger>
			<LineMenu catalogId={catalogId} product={p} carriers={carriers} />
		</ContextMenu>
	);
}

// A product row's right-click menu. Remove from supplier lists the carriers
// that sell it; Add back to supplier the ones that have it unavailable.
function LineMenu({
	catalogId,
	product: p,
	carriers,
}: {
	catalogId: number;
	product: CatalogProduct;
	carriers: Carrier[];
}) {
	const navigate = useNavigate();
	const selling = carriers.filter((s) =>
		p.offers.some((o) => o.supplierId === s.id),
	);
	const away = carriers.filter((s) => p.unavailable.includes(s.id));
	const url = `/products/${encodeURIComponent(p.sku)}`;
	return (
		<ContextMenuContent>
			<ContextMenuItem
				onSelect={() =>
					navigate({ to: "/products/$sku", params: { sku: p.sku } })
				}
				shortcut="↵"
			>
				<FileText />
				Open
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => window.open(url, "_blank")}>
				<ExternalLink />
				Open in new tab
			</ContextMenuItem>
			{(selling.length > 0 || away.length > 0) && <ContextMenuSeparator />}
			{selling.length > 0 && (
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<Ban />
						Remove from supplier
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						{selling.map((s) => (
							<ContextMenuItem
								key={s.id}
								onSelect={() => markUnavailable(catalogId, p, s)}
							>
								{s.name}
							</ContextMenuItem>
						))}
					</ContextMenuSubContent>
				</ContextMenuSub>
			)}
			{away.length > 0 && (
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<Undo2 />
						Add back to supplier
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						{away.map((s) => (
							<ContextMenuItem
								key={s.id}
								onSelect={() => markAvailable(catalogId, p, s)}
							>
								{s.name}
							</ContextMenuItem>
						))}
					</ContextMenuSubContent>
				</ContextMenuSub>
			)}
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => copyText(p.sku)}>
				<Copy />
				Copy SKU
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => takeOut(catalogId, p)}>
				<PackageX />
				Take out of catalog
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

// One supplier's price and part number for one product, per their unit, with
// what one item works out to when they sell in packs. Both change in place.
function PriceCell({
	catalogId,
	product: p,
	supplier: s,
	offer: o,
	unavailable,
	compared,
}: {
	catalogId: number;
	product: CatalogProduct;
	supplier: Carrier;
	offer: CatalogOffer | null;
	unavailable: boolean;
	compared: boolean;
}) {
	if (unavailable)
		return (
			<td className="px-4 py-2.5 text-right text-xs whitespace-nowrap text-faint">
				Unavailable
			</td>
		);
	// Tool sets have no offers: they're bought as their parts. Otherwise
	// there's none only for a moment, while one added back loads.
	if (!o) return <td className="px-4 py-2.5" />;
	const best = o.cheapest && compared && o.cost !== null;
	const pack = [
		o.packSize > 1 && `${o.unit} of ${o.packSize}`,
		o.packSize > 1 && o.itemCost !== null && `${formatMoney(o.itemCost)} each`,
	]
		.filter(Boolean)
		.join(" · ");
	const save = (label: string, terms: OfferTerms) =>
		saveTerms(catalogId, p.id, s.id, label, terms);
	return (
		<td
			className={cn(
				"px-4 py-2 text-right whitespace-nowrap",
				best && "bg-success-surface",
			)}
		>
			<div className="flex flex-col items-end gap-0.5">
				<InlineField
					shown={formatMoney(o.cost)}
					initial={o.cost === null ? "" : String(o.cost)}
					placeholder="Add price"
					label={`${s.name}'s price for ${p.sku}`}
					inputMode="decimal"
					align="right"
					className="w-32"
					onSave={async (text) => {
						const cost = text === "" ? null : Number(text.replace(/^\$/, ""));
						if (cost !== null && !(Number.isFinite(cost) && cost >= 0)) {
							toast.error(`"${text}" isn't a price`);
							return false;
						}
						return save(`${s.name}'s price for ${p.sku}`, { cost });
					}}
				/>
				<InlineField
					shown={o.supplierSku ?? ""}
					initial={o.supplierSku ?? ""}
					placeholder="Add SKU"
					label={`${s.name}'s SKU for ${p.sku}`}
					align="right"
					className="h-7 w-32 text-xs text-muted-foreground"
					onSave={(text) =>
						save(`${s.name}'s SKU for ${p.sku}`, {
							supplierSku: text === "" ? null : text,
						})
					}
				/>
				{pack && (
					<div className="px-1.5 text-xs text-muted-foreground">{pack}</div>
				)}
				<BulkPrices
					catalogId={catalogId}
					productId={p.id}
					label={`${s.name}'s ${p.sku}`}
					offer={o}
				/>
			</div>
		</td>
	);
}

type OfferTerms = { cost: number | null } | { supplierSku: string | null };

// Changes one supplier's terms for a product, in place on the table.
async function saveTerms(
	catalogId: number,
	productId: number,
	supplierId: number,
	label: string,
	terms: OfferTerms,
) {
	const r = await optimism.change({
		label,
		patch: patchCatalog(catalogId, (d) => ({
			...d,
			products: d.products.map((x) =>
				x.id !== productId
					? x
					: {
							...x,
							offers: x.offers.map((y) =>
								y.supplierId !== supplierId
									? y
									: "cost" in terms
										? {
												...y,
												cost: terms.cost,
												itemCost:
													terms.cost === null ? null : terms.cost / y.packSize,
											}
										: { ...y, supplierSku: terms.supplierSku },
							),
						},
			),
		})),
		send: () => setSupplierTerms({ data: { productId, supplierId, ...terms } }),
	});
	return r !== null;
}

// Marks a product unavailable from one supplier, so reorder buys it from
// another. Its terms are kept, so Undo or Add back to supplier restores them.
async function markUnavailable(
	catalogId: number,
	p: CatalogProduct,
	s: Carrier,
) {
	const offer = p.offers.find((o) => o.supplierId === s.id);
	const r = await flipUnavailable(catalogId, p, s, true, `Removing ${p.sku}`);
	if (!r) return;
	offerUndo(`${s.name} doesn't sell ${p.sku} now`, {
		undo: async () => {
			const back = await flipUnavailable(
				catalogId,
				p,
				s,
				false,
				`Adding ${p.sku} back`,
				offer,
			);
			return back ? `${s.name} sells ${p.sku} again` : null;
		},
	});
}

const markAvailable = (catalogId: number, p: CatalogProduct, s: Carrier) =>
	flipUnavailable(catalogId, p, s, false, `Adding ${p.sku} back`);

// Shows the supplier's cell as Unavailable, or its offer (`offer` when it's
// known; the reload brings it otherwise), while the server catches up.
async function flipUnavailable(
	catalogId: number,
	p: CatalogProduct,
	s: Carrier,
	unavailable: boolean,
	label: string,
	offer?: CatalogOffer,
) {
	const r = await optimism.change({
		label,
		patch: patchCatalog(catalogId, (d) => ({
			...d,
			products: d.products.map((x) =>
				x.id !== p.id
					? x
					: {
							...x,
							offers: unavailable
								? x.offers.filter((o) => o.supplierId !== s.id)
								: offer && !x.offers.some((o) => o.supplierId === s.id)
									? [...x.offers, offer]
									: x.offers,
							unavailable: unavailable
								? [...x.unavailable.filter((id) => id !== s.id), s.id]
								: x.unavailable.filter((id) => id !== s.id),
						},
			),
		})),
		send: () =>
			setSupplierUnavailable({
				data: { supplierId: s.id, productIds: [p.id], unavailable },
			}),
	});
	return r !== null;
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
