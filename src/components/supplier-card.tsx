import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Card } from "#/components/page";
import {
	type PurchaseTerms,
	PurchaseUnitCell,
} from "#/components/purchase-unit";
import { Button } from "#/components/ui/button";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import { optimism, type Patch } from "#/lib/optimism";
import { perPack } from "#/purchasing/pack";
import {
	type getProductSupplier,
	listSuppliers,
	type SupplierRow,
	setProductPurchaseUnit,
	setProductSupplier,
} from "#/server/purchasing";

type ProductSupplier = Awaited<ReturnType<typeof getProductSupplier>>;
type SupplierLink = NonNullable<ProductSupplier["link"]>;

// Who a product is bought from, and the POs it's on. Products without a
// supplier are never suggested for reordering, so setting one is right here.
// `patch` says how a change shows on the page the card is on: it gets the link
// as it will be and returns the change for it. Without it, changes wait for
// the server.
export function SupplierCard({
	productId,
	data,
	patch,
}: {
	productId: number;
	data: ProductSupplier;
	patch?: (link: SupplierLink | null) => { label: string; patch: Patch };
}) {
	const [editing, setEditing] = useState(false);
	const { link, open, units } = data;

	// The cell makes the change; this is just the server call, and the patch
	// that shows it here.
	const saveTerms = (terms: PurchaseTerms) =>
		setProductPurchaseUnit({ data: { productId, ...terms } });
	const patchTerms =
		link && patch
			? (terms: PurchaseTerms) => patch(termsLink(link, terms)).patch
			: undefined;

	return (
		<Card
			title="Supplier"
			aside={
				!editing && (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="text-link hover:underline"
					>
						{link ? "Edit" : "Set"}
					</button>
				)
			}
		>
			{editing ? (
				<SupplierForm
					productId={productId}
					link={link}
					patch={patch}
					onDone={() => setEditing(false)}
				/>
			) : link ? (
				<dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1">
					<dt className="text-muted-foreground">From</dt>
					<dd className="truncate font-medium">{link.supplierName}</dd>
					<dt className="text-muted-foreground">Their SKU</dt>
					<dd className="truncate">{link.supplierSku ?? "—"}</dd>
					<dt className="text-muted-foreground">Bought in</dt>
					<dd>
						<PurchaseUnitCell
							label="this product"
							value={link}
							cost={link.cost}
							units={units.map((u) => u.name)}
							saving={{ save: saveTerms, patch: patchTerms }}
						/>
					</dd>
					<dt className="text-muted-foreground">Price</dt>
					<dd className="tabular-nums">
						{formatMoney(link.cost)}
						{link.cost !== null && link.unit !== "EACH" && (
							<span className="text-muted-foreground"> per {link.unit}</span>
						)}
					</dd>
				</dl>
			) : (
				<p className="text-muted-foreground">
					None. Never suggested for reorder.
				</p>
			)}
			{!editing && open.length > 0 && (
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

// The link once its terms are saved. The server also converts the price to
// the new pack size.
function termsLink(link: SupplierLink, terms: PurchaseTerms): SupplierLink {
	return {
		...link,
		...terms,
		cost:
			link.cost === null
				? null
				: perPack(link.cost, link.packSize, terms.packSize),
	};
}

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

function SupplierForm({
	productId,
	link,
	patch,
	onDone,
}: {
	productId: number;
	link: SupplierLink | null;
	patch?: (link: SupplierLink | null) => { label: string; patch: Patch };
	onDone: () => void;
}) {
	const [suppliers, setSuppliers] = useState<SupplierRow[] | null>(null);
	const [busy, setBusy] = useState(false);
	if (suppliers === null) listSuppliers().then(setSuppliers);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		const supplierId = Number(f.get("supplierId")) || null;
		const cost = String(f.get("cost") ?? "").trim();
		const price = cost === "" ? null : Number(cost);
		if (price !== null && !(Number.isFinite(price) && price >= 0))
			return toast.error(`"${cost}" isn't a price`);
		const supplierSku = String(f.get("supplierSku") ?? "");
		const picked = suppliers?.find((s) => s.supplier.id === supplierId);
		if (supplierId !== null && !picked) return toast.error("Pick a supplier");

		// As the server saves it. A new supplier keeps the terms the link had,
		// and a new link starts at the defaults.
		const next: SupplierLink | null = picked
			? {
					supplierId: picked.supplier.id,
					supplierName: picked.supplier.name,
					supplierSku: supplierSku.trim() || null,
					cost: price,
					unit: link?.unit ?? "EACH",
					packSize: link?.packSize ?? 1,
					supplierCount: link?.supplierCount ?? 1,
					minimumQuantity: link?.minimumQuantity ?? 1,
				}
			: null;
		const send = () =>
			setProductSupplier({
				data: {
					productId,
					supplierId,
					...(supplierId && { supplierSku, cost: price }),
				},
			});

		const laid = patch?.(next);
		// A change that shows at once closes the form now; otherwise it waits.
		if (laid) onDone();
		else setBusy(true);
		const r = await optimism.change(laid ? { ...laid, send } : { send });
		setBusy(false);
		if (r && !laid) onDone();
	}

	return (
		<form
			onSubmit={submit}
			onKeyDown={(e) => e.key === "Escape" && onDone()}
			className="flex flex-col gap-2"
		>
			<select
				name="supplierId"
				defaultValue={link?.supplierId ?? ""}
				className={input}
				disabled={suppliers === null}
			>
				<option value="">No supplier</option>
				{suppliers?.map((s) => (
					<option key={s.supplier.id} value={s.supplier.id}>
						{s.supplier.name}
					</option>
				))}
			</select>
			<input
				name="supplierSku"
				placeholder="Their SKU"
				defaultValue={link?.supplierSku ?? ""}
				className={input}
			/>
			<input
				name="cost"
				inputMode="decimal"
				placeholder={`Price per ${link?.unit ?? "EACH"}`}
				defaultValue={link?.cost ?? ""}
				className={input}
			/>
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={busy || suppliers === null}>
					Save
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
