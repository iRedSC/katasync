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

// Why a return can't be received on an order, or null when it can. Returns
// come back here once everything has left our own shelf: fulfilled, or with
// a label bought even if the marketplace never heard it shipped (`labeled`:
// order_profit's labels_status is known or stand_in). Needing no label isn't
// proof: a pickup can be paid for and still on the shelf. One rule for the
// page's button and the server.
export function returnBlocker(order: {
	name: string;
	cancelledAt: Date | null;
	fulfilledByChannel: boolean;
	fulfillmentStatus: string;
	labeled: boolean;
}): string | null {
	if (order.fulfilledByChannel) {
		return `${order.name} was shipped by the marketplace, so its returns go back there`;
	}
	if (order.cancelledAt) {
		return `${order.name} was cancelled, so its stock already came back`;
	}
	if (order.fulfillmentStatus === "PARTIALLY_FULFILLED") {
		return "Receive returns after the remaining items ship or are cancelled";
	}
	if (order.fulfillmentStatus !== "FULFILLED" && !order.labeled) {
		return `${order.name} hasn't shipped yet`;
	}
	return null;
}

// A label was bought for the order, by katasync or the marketplace.
export const isLabeled = (labelsStatus: string | undefined) =>
	labelsStatus === "known" || labelsStatus === "stand_in";
