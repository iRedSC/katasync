import { offerUndo } from "#/lib/undo";
import { cancelPurchaseOrder, restorePurchaseOrder } from "#/server/purchasing";

// Deletes a draft or cancels a sent PO, with Undo instead of a confirm. Used
// by the PO list and the PO itself, so both say the same thing. Throws when
// it can't, e.g. something has arrived since.
export async function cancelWithUndo(
	po: { id: number; status: "draft" | "sent"; supplierName: string },
	reload: () => Promise<void>,
) {
	const name = `PO ${po.id}`;
	const draft = po.status === "draft";
	await cancelPurchaseOrder({ data: { id: po.id } });
	await reload();
	offerUndo(draft ? `Deleted draft ${name}` : `Cancelled ${name}`, {
		description: draft ? undefined : `${po.supplierName} isn't told`,
		undo: async () => {
			const back = await restorePurchaseOrder({ data: { id: po.id } });
			await reload();
			return back === "draft"
				? `${name} is a draft again`
				: `${name} is on order again`;
		},
	});
}
