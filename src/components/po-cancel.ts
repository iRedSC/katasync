import { offerUndo } from "#/lib/undo";
import {
	cancelPurchaseOrder,
	deleteDraftPurchaseOrder,
	restoreDraftPurchaseOrder,
	restorePurchaseOrder,
} from "#/server/purchasing";

// Deletes a draft or cancels a sent PO, with Undo instead of a confirm. Used
// by the PO list and the PO itself, so both say the same thing. Throws when
// it can't, e.g. something has arrived since.
export async function cancelWithUndo(
	po: { id: number; status: "draft" | "sent"; supplierName: string },
	reload: () => Promise<void>,
) {
	const name = `PO ${po.id}`;
	if (po.status === "draft") {
		const deleted = await deleteDraftPurchaseOrder({ data: { id: po.id } });
		await reload();
		offerUndo(`Deleted draft ${name}`, {
			undo: async () => {
				await restoreDraftPurchaseOrder({ data: deleted });
				await reload();
				return `${name} is back`;
			},
		});
		return;
	}
	await cancelPurchaseOrder({ data: { id: po.id } });
	await reload();
	offerUndo(`Cancelled ${name}`, {
		description: `${po.supplierName} isn't told`,
		undo: async () => {
			await restorePurchaseOrder({ data: { id: po.id } });
			await reload();
			return `${name} is on order again`;
		},
	});
}
