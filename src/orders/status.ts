import type { Tone } from "#/components/page";
import { externalFulfillment } from "./fulfillment";

// Every state an order can be in, as a one-word key the orders search
// types (%unfulfilled) and the words its badge shows.
export const ORDER_STATUSES = {
	void: "Cancelled or refunded, void label",
	cancelled: "Cancelled",
	refunded: "Refunded",
	fulfilled: "Fulfilled",
	noshipping: "No shipping needed",
	restocked: "Restocked",
	partial: "Partly shipped",
	unpaid: "Waiting for payment",
	hold: "On hold",
	external: "Fulfill externally",
	unfulfilled: "To ship",
} as const;
export type OrderStatusKey = keyof typeof ORDER_STATUSES;

// How an order's state reads to a person, in one place so lists, detail
// pages, and search agree. Only states that need attention get a color.
export function orderStatus(order: {
	cancelledAt: Date | null;
	fulfillmentStatus: string;
	financialStatus: string | null;
	channel: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
	externalId: string;
	shipCountry: string | null;
	// Cancelled or refunded with a label still live (see to-ship.ts).
	labelToVoid?: boolean;
}): { key: OrderStatusKey; label: string; tone?: Tone } {
	const is = (key: OrderStatusKey, tone?: Tone) => ({
		key,
		label: ORDER_STATUSES[key],
		tone,
	});
	if (order.labelToVoid) {
		return {
			key: "void",
			label: `${order.cancelledAt ? "Cancelled" : "Refunded"}, void label`,
			tone: "critical",
		};
	}
	if (order.cancelledAt) return is("cancelled");
	if (order.financialStatus === "REFUNDED") return is("refunded");
	switch (order.fulfillmentStatus) {
		case "FULFILLED":
			return is("fulfilled");
		case "FULFILLMENT_NOT_REQUIRED":
			return is("noshipping");
		// Shopify: every item was removed or refunded before shipping.
		case "RESTOCKED":
			return is("restocked");
		case "PARTIALLY_FULFILLED":
			return is("partial", "warning");
		case "AWAITING_PAYMENT":
			return is("unpaid");
		case "ON_HOLD":
			return is("hold", "warning");
		default:
			// Shipped from the marketplace's own page, not from katasync.
			return externalFulfillment(order)
				? is("external", "info")
				: is("unfulfilled", "warning");
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
	shippedQuantity?: number;
}): string | null {
	if (order.fulfilledByChannel) {
		return `${order.name} was shipped by the marketplace, so its returns go back there`;
	}
	if (order.shippedQuantity !== undefined)
		return order.shippedQuantity > 0
			? null
			: `${order.name} hasn't shipped yet`;
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
