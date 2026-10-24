import type { Tone } from "#/components/page";
import { externalFulfillment } from "./fulfillment";

// Every state an order can be in, as a one-word key the orders search
// types (%unfulfilled) and the words its badge shows.
export const ORDER_STATUSES = {
	void: "Cancelled or refunded, void label",
	unfulfilled: "Unfulfilled",
	// Unfulfilled too, but shipped from the marketplace's own page.
	external: "Unfulfilled",
	pending: "Pending",
	fulfilled: "Fulfilled",
	cancelled: "Cancelled",
	refunded: "Refunded",
	returning: "Returning",
	returned: "Returned",
} as const;
export type OrderStatusKey = keyof typeof ORDER_STATUSES;

// Where a return stands: one requested or expected and not yet received,
// or received. From returnStages (return-stage.ts).
export type ReturnStage = "returning" | "returned" | null;

// One shipped from the marketplace's page links there.
export type OrderStatus =
	| { key: Exclude<OrderStatusKey, "external">; label: string; tone?: Tone }
	| {
			key: "external";
			label: string;
			tone: "info";
			url: string;
			on: string;
	  };

// How an order's state reads to a person, in one place so lists, detail
// pages, search, and the inbox agree. Only states that need someone get a
// color: yellow to ship here, blue to ship on the marketplace.
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
	labelToVoid: boolean;
	returnStage: ReturnStage;
}): OrderStatus {
	const is = (key: Exclude<OrderStatusKey, "external">, tone?: Tone) => ({
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
	if (order.returnStage) return is(order.returnStage);
	if (order.cancelledAt) return is("cancelled");
	if (order.financialStatus === "REFUNDED") return is("refunded");
	switch (order.fulfillmentStatus) {
		case "FULFILLED":
		case "FULFILLMENT_NOT_REQUIRED":
			return is("fulfilled");
		// Shopify: every item was removed or refunded before shipping.
		case "RESTOCKED":
			return is("cancelled");
		case "AWAITING_PAYMENT":
		case "ON_HOLD":
			return is("pending");
		default: {
			// Partly shipped is still unfulfilled: the rest has to go.
			const external = externalFulfillment(order);
			return external
				? {
						key: "external",
						label: ORDER_STATUSES.external,
						tone: "info",
						url: external.url,
						on: external.name,
					}
				: is("unfulfilled", "warning");
		}
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
