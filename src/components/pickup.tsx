import { toast } from "sonner";
import { optimism } from "#/lib/optimism";
import { offerUndo } from "#/lib/undo";
import {
	pickUpOrder,
	readyOrderForPickup,
	undoOrderPickedUp,
} from "#/server/pickup";

type Named = { id: number; name: string };

// Set aside: Shopify emails the buyer to come get it. Shopify has no way to
// take that email back, so there's no undo; the badge turning blue says it
// went.
export async function readyForPickup(order: Named) {
	const r = await optimism.change({
		send: () => readyOrderForPickup({ data: { orderId: order.id } }),
	});
	if (r) toast.success(`${order.name} is ready; Shopify emailed the buyer`);
}

// The buyer has it: Shopify fulfills it and it leaves To ship. Undo puts it
// back to wait for pickup.
export async function pickedUp(order: Named) {
	const r = await optimism.change({
		send: () => pickUpOrder({ data: { orderId: order.id } }),
	});
	if (!r) return;
	if (r.value.problems.length > 0) toast.error(r.value.problems.join("; "));
	offerUndo(`${order.name} picked up`, {
		undo: async () => {
			const back = await optimism.change({
				send: () => undoOrderPickedUp({ data: { orderId: order.id } }),
			});
			return back && `${order.name} is waiting for pickup again`;
		},
	});
}
