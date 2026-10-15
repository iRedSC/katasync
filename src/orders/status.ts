import type { Tone } from "#/components/page";
import { externalFulfillment } from "./fulfillment";

// How an order's state reads to a person, in one place so lists and detail
// pages agree. Only states that need attention get a color.
export function orderStatus(order: {
	cancelledAt: Date | null;
	fulfillmentStatus: string;
	financialStatus: string | null;
	channel: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
	// Cancelled or refunded with a label still live (see to-ship.ts).
	labelToVoid?: boolean;
}): { label: string; tone?: Tone } {
	if (order.labelToVoid) {
		return {
			label: `${order.cancelledAt ? "Cancelled" : "Refunded"}, void label`,
			tone: "critical",
		};
	}
	if (order.cancelledAt) return { label: "Cancelled" };
	if (order.financialStatus === "REFUNDED") return { label: "Refunded" };
	switch (order.fulfillmentStatus) {
		case "FULFILLED":
			return { label: "Fulfilled" };
		case "FULFILLMENT_NOT_REQUIRED":
			return { label: "No shipping needed" };
		// Shopify: every item was removed or refunded before shipping.
		case "RESTOCKED":
			return { label: "Restocked" };
		case "PARTIALLY_FULFILLED":
			return { label: "Partly shipped", tone: "warning" };
		case "AWAITING_PAYMENT":
			return { label: "Waiting for payment" };
		case "ON_HOLD":
			return { label: "On hold", tone: "warning" };
		default:
			// Shipped from the marketplace's own page, not from katasync.
			return externalFulfillment(order)
				? { label: "Fulfill externally", tone: "info" }
				: { label: "To ship", tone: "warning" };
	}
}
