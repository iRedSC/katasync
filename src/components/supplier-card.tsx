import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CatalogSelect } from "#/components/catalog-picker";
import { Badge, Card } from "#/components/page";
import { InlineField } from "#/components/purchase-order/inline-fields";
import {
	type PurchaseTerms,
	PurchaseUnitCell,
} from "#/components/purchase-unit";
import { Tip } from "#/components/ui/tooltip";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import { cn } from "#/lib/utils";
import { perPack } from "#/purchasing/pack";
import {
	type CatalogRow,
	type getProductSupplier,
	listCatalogs,
	listSuppliers,
	makeCatalog,
	restoreProductCatalogs,
	type SupplierRow,
	setProductCatalog,
	setProductPurchaseUnit,
	setSupplierCarries,
	setSupplierTerms,
} from "#/server/purchasing";

type ProductSupplier = Awaited<ReturnType<typeof getProductSupplier>>;
export type Offer = ProductSupplier["offers"][number];

// Who sells a product: its catalog, and every supplier carrying that
// catalog with their part number, price, and unit. Reorder buys from the
// cheapest per single item, marked here. `patch` says how a change to the
// offers shows on the page the card is on; without it, changes wait for the
// server.
export function SupplierCard({
	productId,
	sku,
	data,
	patch,
}: {
	productId: number;
	sku: string;
	data: ProductSupplier;
	patch?: (offers: Offer[]) => { label: string; patch: Patch };
}) {
	const { catalog, offers, open, units } = data;
	const [catalogs, setCatalogs] = useState<CatalogRow[] | null>(null);
	const [busy, setBusy] = useState(false);
	const load = () => {
		if (catalogs === null) listCatalogs().then(setCatalogs);
	};

	// The suppliers change with the catalog, so this waits for the server.
	// Undo puts it back, terms and all: they're kept per supplier.
	async function moveTo(next: { id: number; name: string } | null) {
		setBusy(true);
		const r = await optimism.change({
			send: () =>
				setProductCatalog({
					data: { productIds: [productId], catalogId: next?.id ?? null },
				}),
		});
		setBusy(false);
		if (!r) return;
		offerUndo(next ? `In ${next.name}` : "Out of any catalog", {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					send: () => restoreProductCatalogs({ data: { before: r.value } }),
				});
				return back && "Put back";
			},
		});
	}

	async function make(name: string) {
		setBusy(true);
		const r = await optimism.change({
			send: () => makeCatalog({ data: { name } }),
		});
		setBusy(false);
		if (r) await moveTo({ id: r.value, name });
	}

	return (
		<Card
			title="Suppliers"
			aside={
				<CatalogSelect
					value={catalog}
					catalogs={catalogs}
					onPick={moveTo}
					onMake={make}
					disabled={busy}
					onOpen={load}
				/>
			}
		>
			{catalog === null ? (
				<p className="text-muted-foreground">
					Not in a catalog, so nobody sells it.
				</p>
			) : (
				<>
					{offers.length === 0 && (
						<p className="text-muted-foreground">
							No supplier carries {catalog.name}.
						</p>
					)}
					<ul className="-mx-1 flex flex-col">
						{offers.map((o) => (
							<OfferRow
								key={o.supplierId}
								productId={productId}
								sku={sku}
								offer={o}
								offers={offers}
								units={units.map((u) => u.name)}
								patch={patch}
							/>
						))}
					</ul>
					<AddSupplier catalog={catalog} carrying={offers} />
				</>
			)}
			{open.length > 0 && (
				<ul className="mt-3 flex flex-col gap-1 border-t pt-3">
					{open.map((po) => (
						<li key={po.id} className="flex justify-between gap-2">
							<Link
								to="/purchasing/$id"
								params={{ id: String(po.id) }}
								className="text-link hover:underline"
							>
								PO {po.id}
							</Link>
							<span className="text-muted-foreground">
								{formatCount(po.quantity)}
								{po.packSize !== 1 && ` ${po.unit}`}{" "}
								{po.status === "draft"
									? "in draft"
									: po.expectedAt
										? `due ${formatDay(po.expectedAt)}`
										: "on order"}
							</span>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

// The offers once one supplier's changes. Which is cheapest also weighs
// lead time on the server, so that stays as it was until the reload.
function withOffer(offers: Offer[], next: Offer): Offer[] {
	return offers.map((o) =>
		o.supplierId === next.supplierId
			? {
					...next,
					itemCost: next.cost === null ? null : next.cost / next.packSize,
				}
			: o,
	);
}

function OfferRow({
	productId,
	sku,
	offer: o,
	offers,
	units,
	patch,
}: {
	productId: number;
	sku: string;
	offer: Offer;
	offers: Offer[];
	units: string[];
	patch?: (offers: Offer[]) => { label: string; patch: Patch };
}) {
	const save = async (
		next: Offer,
		send: () => Promise<unknown>,
	): Promise<boolean> => {
		const laid = patch?.(withOffer(offers, next));
		const r = await optimism.change(laid ? { ...laid, send } : { send });
		return r !== null;
	};
	const saveTerms = (terms: PurchaseTerms) =>
		setProductPurchaseUnit({
			data: { productId, supplierId: o.supplierId, ...terms },
		});
	const patchTerms = patch
		? (terms: PurchaseTerms) =>
				patch(
					withOffer(offers, {
						...o,
						...terms,
						cost:
							o.cost === null
								? null
								: perPack(o.cost, o.packSize, terms.packSize),
					}),
				).patch
		: undefined;

	return (
		<li
			className={cn(
				"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1 py-1 transition-colors",
				o.cheapest && offers.length > 1 && "bg-success-surface",
			)}
		>
			<div className="flex min-w-0 items-center gap-1.5">
				<span className="truncate font-medium">{o.supplierName}</span>
				{o.cheapest && offers.length > 1 && (
					<Tip content="Reorder buys from the lowest price per item">
						<span className="inline-flex">
							<Badge tone="success">Reorders</Badge>
						</span>
					</Tip>
				)}
			</div>
			<InlineField
				shown={formatMoney(o.cost)}
				initial={o.cost === null ? "" : String(o.cost)}
				placeholder="Price"
				label={`${o.supplierName}'s price for ${sku}`}
				inputMode="decimal"
				align="right"
				className="w-24"
				onSave={async (text) => {
					const cost = text === "" ? null : Number(text);
					if (cost !== null && !(Number.isFinite(cost) && cost >= 0)) {
						toast.error(`"${text}" isn't a price`);
						return false;
					}
					return save({ ...o, cost }, () =>
						setSupplierTerms({
							data: { productId, supplierId: o.supplierId, cost },
						}),
					);
				}}
			/>
			<div className="flex min-w-0 items-center gap-2 text-muted-foreground">
				<InlineField
					shown={o.supplierSku ?? ""}
					initial={o.supplierSku ?? ""}
					placeholder="Their SKU"
					label={`${o.supplierName}'s SKU for ${sku}`}
					className="w-28 -ml-1.5"
					onSave={async (text) =>
						save({ ...o, supplierSku: text === "" ? null : text }, () =>
							setSupplierTerms({
								data: {
									productId,
									supplierId: o.supplierId,
									supplierSku: text === "" ? null : text,
								},
							}),
						)
					}
				/>
				<PurchaseUnitCell
					label={`${sku} from ${o.supplierName}`}
					value={o}
					cost={o.cost}
					units={units}
					saving={{ save: saveTerms, patch: patchTerms }}
				/>
			</div>
			<span className="pr-1.5 text-right text-xs text-muted-foreground tabular-nums">
				{o.itemCost !== null &&
					o.packSize > 1 &&
					`${formatMoney(o.itemCost)} each`}
			</span>
		</li>
	);
}

// Has another supplier carry the catalog, so it sells all of it. Says so,
// with Undo, since it reaches every product in the catalog.
function AddSupplier({
	catalog,
	carrying,
}: {
	catalog: { id: number; name: string };
	carrying: Offer[];
}) {
	const [suppliers, setSuppliers] = useState<SupplierRow[] | null>(null);
	const [busy, setBusy] = useState(false);
	const others = suppliers?.filter(
		(s) => !carrying.some((o) => o.supplierId === s.supplier.id),
	);
	const carry = (supplierId: number, carried: boolean) =>
		setSupplierCarries({
			data: { supplierId, catalogId: catalog.id, carried },
		});

	async function add(supplierId: number) {
		const name = suppliers?.find((s) => s.supplier.id === supplierId)?.supplier
			.name;
		setBusy(true);
		const r = await optimism.change({ send: () => carry(supplierId, true) });
		setBusy(false);
		if (!r) return;
		offerUndo(`${name} now carries ${catalog.name}`, {
			tone: "success",
			undo: async () => {
				const back = await optimism.change({
					send: () => carry(supplierId, false),
				});
				return back && `${name} no longer carries ${catalog.name}`;
			},
		});
	}

	return (
		<select
			value=""
			disabled={busy}
			onPointerDown={() => {
				if (suppliers === null) listSuppliers().then(setSuppliers);
			}}
			onFocus={() => {
				if (suppliers === null) listSuppliers().then(setSuppliers);
			}}
			onChange={(e) => {
				const id = Number(e.target.value);
				if (id) add(id);
			}}
			aria-label={`Another supplier carrying ${catalog.name}`}
			className="mt-2 h-8 w-full cursor-pointer rounded-lg border border-dashed border-input bg-transparent px-2 text-muted-foreground hover:border-ring"
		>
			<option value="">+ Another supplier carries {catalog.name}</option>
			{others?.map((s) => (
				<option key={s.supplier.id} value={s.supplier.id}>
					{s.supplier.name}
				</option>
			))}
		</select>
	);
}
