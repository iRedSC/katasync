import { type } from "arktype";
import { API, accessToken, ebayCarrierCode } from "#/channels/ebay";
import { assertUnchanged, driftOf, unmappable } from "./packed";

// eBay's own word on an order before katasync buys for it or tells eBay it
// shipped: GET /sell/fulfillment/v1/order/{orderId} and its
// shipping_fulfillment list. Anything there katasync can't account for
// exactly (a cancellation request, a refund, a fulfillment without its
// lines) is held for a person rather than guessed at.

const order = type({
	"cancelStatus?": { "cancelState?": "string" },
	lineItems: type({
		lineItemId: "string",
		title: "string",
		quantity: "number.integer >= 0",
		"refunds?": "unknown[]",
	}).array(),
});

const fulfillmentList = type({
	"fulfillments?": type({
		fulfillmentId: "string",
		"shipmentTrackingNumber?": "string",
		"lineItems?": type({
			lineItemId: "string",
			quantity: "number.integer >= 0",
		}).array(),
	}).array(),
});

export type EbayRead = {
	order: typeof order.infer;
	fulfillments: NonNullable<(typeof fulfillmentList.infer)["fulfillments"]>;
};

async function get(url: string) {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${await accessToken()}` },
	});
	if (!response.ok) {
		throw new Error(
			`eBay answered ${response.status}: ${await response.text()}`,
		);
	}
	return response.json();
}

const orderUrl = (orderId: string) =>
	`${API}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`;

export async function ebayRead(orderId: string): Promise<EbayRead> {
	const [o, f] = await Promise.all([
		get(orderUrl(orderId)),
		get(`${orderUrl(orderId)}/shipping_fulfillment`),
	]);
	return {
		order: order.assert(o),
		fulfillments: fulfillmentList.assert(f).fulfillments ?? [],
	};
}

// What eBay still has to ship, by line: each line's quantity less what its
// fulfillments already carry.
export function ebayOpen(read: EbayRead) {
	const state = read.order.cancelStatus?.cancelState;
	if (state && state !== "NONE_REQUESTED") {
		throw unmappable(
			"eBay has a cancellation on this order; settle it in Seller Hub",
		);
	}
	if (read.order.lineItems.some((l) => (l.refunds ?? []).length > 0)) {
		throw unmappable(
			"eBay shows a refund on this order; check it in Seller Hub",
		);
	}
	const shipped = new Map<string, number>();
	for (const f of read.fulfillments) {
		if (!f.lineItems) {
			throw unmappable(
				"eBay has a shipment katasync can't read; check it in Seller Hub",
			);
		}
		for (const l of f.lineItems) {
			shipped.set(l.lineItemId, (shipped.get(l.lineItemId) ?? 0) + l.quantity);
		}
	}
	const open = new Map<string, number>();
	const titles = new Map<string, string>();
	for (const l of read.order.lineItems) {
		titles.set(l.lineItemId, l.title);
		const left = l.quantity - (shipped.get(l.lineItemId) ?? 0);
		if (left > 0) open.set(l.lineItemId, left);
	}
	return { open, titles };
}

export async function ebayAssertAsPacked(
	orderId: string,
	packed: Map<string, number>,
) {
	const { open, titles } = ebayOpen(await ebayRead(orderId));
	assertUnchanged(packed, open, titles);
}

// Tells eBay these packed quantities shipped with this tracking; eBay tells
// the buyer. eBay takes one tracking number per line item, so it's the
// first box's. Safe to repeat: a fulfillment already carrying the tracking
// is returned, only if it holds exactly what was packed. Returns how much
// the order still has to ship after it.
export async function ebayShip(
	orderId: string,
	packed: Map<string, number>,
	shipment: { carrier: string; trackingNumber: string; shippedAt: Date },
): Promise<{ fulfillmentId: string | null; remaining: number }> {
	const read = await ebayRead(orderId);
	const { open, titles } = ebayOpen(read);
	const remaining = [...open.values()].reduce((sum, n) => sum + n, 0);
	const already = read.fulfillments.find(
		(f) => f.shipmentTrackingNumber === shipment.trackingNumber,
	);
	if (already) {
		const sent = new Map(
			(already.lineItems ?? []).map((l) => [l.lineItemId, l.quantity]),
		);
		if (driftOf(packed, sent, titles).length > 0) {
			throw unmappable(
				"eBay already has this tracking on a shipment of other items; fix it in Seller Hub",
			);
		}
		return { fulfillmentId: already.fulfillmentId, remaining };
	}
	assertUnchanged(packed, open, titles);
	const response = await fetch(`${orderUrl(orderId)}/shipping_fulfillment`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await accessToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			lineItems: [...packed].map(([lineItemId, quantity]) => ({
				lineItemId,
				quantity,
			})),
			shippedDate: shipment.shippedAt.toISOString(),
			shippingCarrierCode: ebayCarrierCode(shipment.carrier),
			trackingNumber: shipment.trackingNumber,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`eBay refused: ${response.status} ${await response.text()}`,
		);
	}
	return {
		fulfillmentId: response.headers.get("location")?.split("/").pop() ?? null,
		remaining: 0,
	};
}
