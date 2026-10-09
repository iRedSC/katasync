import type { Tone } from "#/components/page";

// How an order's state reads to a person, in one place so lists and detail
// pages agree. Only states that need attention get a color.
export function orderStatus(order: {
	cancelledAt: Date | null;
	fulfillmentStatus: string;
	financialStatus: string | null;
}): { label: string; tone?: Tone } {
	if (order.cancelledAt) return { label: "Cancelled" };
	if (order.financialStatus === "REFUNDED") return { label: "Refunded" };
	switch (order.fulfillmentStatus) {
		case "FULFILLED":
			return { label: "Fulfilled" };
		case "FULFILLMENT_NOT_REQUIRED":
			return { label: "No shipping needed" };
		case "PARTIALLY_FULFILLED":
			return { label: "Partly shipped", tone: "warning" };
		case "ON_HOLD":
			return { label: "On hold", tone: "warning" };
		default:
			return { label: "To ship", tone: "warning" };
	}
}
