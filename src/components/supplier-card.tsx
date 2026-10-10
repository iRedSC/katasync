import { Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Card } from "#/components/page";
import { Button } from "#/components/ui/button";
import { formatCount, formatDay, formatMoney } from "#/lib/format";
import {
	type getProductSupplier,
	listSuppliers,
	type SupplierRow,
	setProductSupplier,
} from "#/server/purchasing";

type ProductSupplier = Awaited<ReturnType<typeof getProductSupplier>>;

// Who a product is bought from, and the POs it's on. Products without a
// supplier are never suggested for reordering, so setting one is right here.
export function SupplierCard({
	productId,
	data,
}: {
	productId: number;
	data: ProductSupplier;
}) {
	const [editing, setEditing] = useState(false);
	const { link, open } = data;

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
					onDone={() => setEditing(false)}
				/>
			) : link ? (
				<dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1">
					<dt className="text-muted-foreground">From</dt>
					<dd className="truncate font-medium">{link.supplierName}</dd>
					<dt className="text-muted-foreground">Their SKU</dt>
					<dd className="truncate">{link.supplierSku ?? "—"}</dd>
					<dt className="text-muted-foreground">Price</dt>
					<dd className="tabular-nums">{formatMoney(link.cost)}</dd>
					{link.minimumQuantity > 1 && (
						<>
							<dt className="text-muted-foreground">Sold in</dt>
							<dd>at least {formatCount(link.minimumQuantity)}</dd>
						</>
					)}
				</dl>
			) : (
				<p className="text-muted-foreground">
					None, so it's never suggested for reordering.
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
								{formatCount(po.quantity)}{" "}
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

const input =
	"h-8 w-full rounded-lg border border-input bg-white px-2 outline-none focus:border-ring";

function SupplierForm({
	productId,
	link,
	onDone,
}: {
	productId: number;
	link: ProductSupplier["link"];
	onDone: () => void;
}) {
	const router = useRouter();
	const [suppliers, setSuppliers] = useState<SupplierRow[] | null>(null);
	const [busy, setBusy] = useState(false);
	if (suppliers === null) listSuppliers().then(setSuppliers);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const f = new FormData(e.currentTarget);
		const supplierId = Number(f.get("supplierId")) || null;
		const cost = String(f.get("cost") ?? "").trim();
		setBusy(true);
		try {
			await setProductSupplier({
				data: {
					productId,
					supplierId,
					...(supplierId && {
						supplierSku: String(f.get("supplierSku") ?? ""),
						cost: cost === "" ? null : Number(cost),
						minimumQuantity: Number(f.get("minimumQuantity")) || 1,
					}),
				},
			});
			await router.invalidate();
			onDone();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
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
			<div className="grid grid-cols-2 gap-2">
				<input
					name="cost"
					inputMode="decimal"
					placeholder="Price each"
					defaultValue={link?.cost ?? ""}
					className={input}
				/>
				<input
					name="minimumQuantity"
					inputMode="numeric"
					placeholder="Min qty"
					defaultValue={link?.minimumQuantity ?? 1}
					className={input}
				/>
			</div>
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
