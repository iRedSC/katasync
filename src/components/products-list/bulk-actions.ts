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
	restoreProductCatalogs,
	setProductCatalog,
	undoManyAddsToPurchaseOrders,
} from "#/server/purchasing";

// What the action bar does to the ticked products. Each says what happened
// and offers to undo it.

const products = (n: number) =>
	`${formatCount(n)} ${n === 1 ? "product" : "products"}`;

// Who can go on a PO now: some supplier sells it and it isn't on a draft
// already.
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

// Puts the ticked products in a catalog, so they're sold by whoever
// carries it. Shown at once; who reorder buys each from follows on the
// reload.
export async function setCatalogOnAll(
	picked: ProductRow[],
	catalog: NonNullable<ProductRow["catalog"]>,
) {
	const ids = picked.map((p) => p.id);
	const moving = picked.filter((p) => p.catalog?.id !== catalog.id);
	if (moving.length === 0) {
		toast(`Already in ${catalog.name}`);
		return;
	}
	const r = await optimism.change({
		label: `${products(moving.length)} into ${catalog.name}`,
		patch: patchProducts(new Set(ids), (p) => ({ ...p, catalog })),
		send: () =>
			setProductCatalog({ data: { productIds: ids, catalogId: catalog.id } }),
	});
	if (!r) return;
	const before = r.value;
	const moved = before.filter((b) => b.catalogId !== catalog.id).length;
	offerUndo(`${products(moved)} now in ${catalog.name}`, {
		tone: "success",
		undo: async () => {
			const was = new Map(picked.map((p) => [p.id, p.catalog]));
			const back = await optimism.change({
				label: `${products(moved)} back`,
				patch: patchProducts(new Set(ids), (p) => ({
					...p,
					catalog: was.get(p.id) ?? null,
				})),
				send: () => restoreProductCatalogs({ data: { before } }),
			});
			return back && `Put ${products(moved)} back`;
		},
	});
}
