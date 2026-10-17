import { createFileRoute, redirect } from "@tanstack/react-router";
import { PurchaseOrderSkeleton } from "#/components/skeleton";
import { openSuggestedPurchaseOrder } from "#/server/purchasing";

// A supplier's suggestion, before it has a PO number. Going here makes (or
// finds) the supplier's suggested PO and lands on it in place of this entry,
// so a click shows the PO's skeleton at once rather than waiting on the list.
export const Route = createFileRoute("/purchasing/suggested/$supplierId")({
	// Making the PO writes to the database, so hovering a link here mustn't.
	preload: false,
	loader: async ({ params }) => {
		const id = await openSuggestedPurchaseOrder({
			data: { supplierId: Number(params.supplierId) },
		});
		throw redirect({
			to: "/purchasing/$id",
			params: { id: String(id) },
			replace: true,
		});
	},
	pendingComponent: PurchaseOrderSkeleton,
});
