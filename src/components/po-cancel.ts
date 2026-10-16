import { optimism, type Patch } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	cancelPurchaseOrder,
	deleteDraftPurchaseOrder,
	restoreDraftPurchaseOrder,
	restorePurchaseOrder,
} from "#/server/purchasing";

// How a page shows a cancel and its undo at once. Without these, the change
// shows once the page has reloaded.
// Undo's can be left off, and then Undo shows once reloaded.
export type CancelPatches = { change: Patch; undo?: Patch };

// Deletes a draft or cancels a sent PO, with Undo instead of a confirm. Used
// by the PO list and the PO itself, so both say the same thing. Resolves to
// whether it went through; when it didn't, the engine has already said why.
// Must not be called from inside another change's send: it makes its own.
export async function cancelWithUndo(
	po: { id: number; status: "draft" | "sent"; supplierName: string },
	// Unused: the engine reloads the page after a change. Still accepted, so
	// existing calls keep working.
	_reload?: () => Promise<void>,
	patches?: CancelPatches,
): Promise<boolean> {
	const name = `PO ${po.id}`;
	if (po.status === "draft") {
		const deleted = await change(
			`Deleting draft ${name}`,
			patches?.change,
			() => deleteDraftPurchaseOrder({ data: { id: po.id } }),
		);
		if (!deleted) return false;
		offerUndo(`Deleted draft ${name}`, {
			undo: async () => {
				const back = await change(`Restoring ${name}`, patches?.undo, () =>
					restoreDraftPurchaseOrder({ data: deleted.value }),
				);
				return back && `${name} is back`;
			},
		});
		return true;
	}
	const cancelled = await change(`Cancelling ${name}`, patches?.change, () =>
		cancelPurchaseOrder({ data: { id: po.id } }),
	);
	if (!cancelled) return false;
	offerUndo(`Cancelled ${name}`, {
		description: `${po.supplierName} isn't told`,
		undo: async () => {
			const back = await change(`Restoring ${name}`, patches?.undo, () =>
				restorePurchaseOrder({ data: { id: po.id } }),
			);
			return back && `${name} is on order again`;
		},
	});
	return true;
}

// A change shown with its patch when there is one, and otherwise once reloaded.
function change<T>(
	label: string,
	patch: Patch | undefined,
	send: () => Promise<T>,
) {
	return patch
		? optimism.change({ label, patch, send })
		: optimism.change({ send });
}
