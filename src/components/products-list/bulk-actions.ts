import { toast } from "sonner";
import { patchProducts } from "#/components/products-list/optimistic";
import { formatCount } from "#/lib/format";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	cancelCountRequest,
	type ProductRow,
	requestManyCounts,
} from "#/server/catalog";
import {
	addManyToPurchaseOrders,
	setManyProductSuppliers,
	undoManyAddsToPurchaseOrders,
	undoManyProductSuppliers,
} from "#/server/purchasing";

// What the action bar does to the ticked products. Each says what happened
// and offers to undo it.

const products = (n: number) =>
	`${formatCount(n)} ${n === 1 ? "product" : "products"}`;

// Who can go on a PO now: has a supplier and isn't on a draft already.
export const orderable = (p: ProductRow) => p.supplier !== null && !p.draft;

// Puts each on its supplier's draft at the suggested quantity, or the
// supplier's minimum when nothing's suggested.
export async function addAllToPos(picked: ProductRow[]) {
	const items = picked.filter(orderable).map((p) => ({
		productId: p.id,
		...(p.reorder ? { quantity: p.reorder.quantity } : {}),
	}));
	if (items.length === 0) return;
	const r = await optimism.change({
		send: () => addManyToPurchaseOrders({ data: { items } }),
	});
	if (!r) return;
	const adds = r.value.flatMap((x) =>
		x.ok && x.added
			? [{ purchaseOrderId: x.purchaseOrderId, line: x.line }]
			: [],
	);
	const failed = r.value.filter((x) => !x.ok);
	const pos = new Set(adds.map((a) => a.purchaseOrderId)).size;
	const extra =
		failed.length > 0
			? `. ${products(failed.length)} couldn't: ${failed[0].ok ? "" : failed[0].why}`
			: "";
	if (adds.length === 0) {
		toast(`Nothing added: already on drafts${extra}`);
		return;
	}
	offerUndo(
		`Added ${products(adds.length)} to ${formatCount(pos)} ${pos === 1 ? "PO" : "POs"}${extra}`,
		{
			tone: "success",
			undo: async () => {
				const undone = await optimism.change({
					send: () => undoManyAddsToPurchaseOrders({ data: { adds } }),
				});
				if (!undone) return null;
				return undone.value < adds.length
					? `Took ${formatCount(undone.value)} of ${formatCount(adds.length)} off; the rest changed since`
					: `Took ${products(adds.length)} off their POs`;
			},
		},
	);
}

export async function countAll(picked: ProductRow[]) {
	const ids = new Set(picked.map((p) => p.id));
	const r = await optimism.change({
		label: `Count requests for ${products(ids.size)}`,
		patch: patchProducts(ids, (p) => ({ ...p, countRequested: true })),
		send: () => requestManyCounts({ data: { productIds: [...ids] } }),
	});
	if (!r) return;
	const added = r.value;
	if (added.length === 0) {
		toast("Already on the count list");
		return;
	}
	offerUndo(`Asked for counts of ${products(ids.size)}`, {
		tone: "success",
		undo: async () => {
			const back = await optimism.change({
				label: "Taking them off the count list",
				patch: patchProducts(ids, (p) => ({ ...p, countRequested: false })),
				send: () => cancelCountRequest({ data: { requests: added } }),
			});
			return back && "Took them off the count list";
		},
	});
}

export async function setSupplierOnAll(
	picked: ProductRow[],
	supplier: { id: number; name: string },
) {
	// Tool sets are bought as their parts.
	const ids = new Set(
		picked.filter((p) => p.kind !== "bundle").map((p) => p.id),
	);
	const sets = picked.length - ids.size;
	if (ids.size === 0) {
		toast.error("Tool sets are bought as their parts; set suppliers on those");
		return;
	}
	const r = await optimism.change({
		label: `Supplier of ${products(ids.size)}`,
		patch: patchProducts(ids, (p) => ({ ...p, supplier })),
		send: () =>
			setManyProductSuppliers({
				data: { productIds: [...ids], supplierId: supplier.id },
			}),
	});
	if (!r) return;
	const { changed } = r.value;
	const skipped =
		sets > 0
			? ` (${formatCount(sets)} tool ${sets === 1 ? "set" : "sets"} left out)`
			: "";
	if (changed.length === 0) {
		toast(`Already from ${supplier.name}${skipped}`);
		return;
	}
	offerUndo(`${products(changed.length)} now from ${supplier.name}${skipped}`, {
		tone: "success",
		undo: async () => {
			const back = await optimism.change({
				send: () =>
					undoManyProductSuppliers({
						data: { supplierId: supplier.id, changed },
					}),
			});
			if (!back) return null;
			return back.value < changed.length
				? `Put ${formatCount(back.value)} of ${formatCount(changed.length)} back; the rest changed since`
				: `Put ${products(changed.length)} back`;
		},
	});
}
