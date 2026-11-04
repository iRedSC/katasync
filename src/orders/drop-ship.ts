import {
	guessCarrier,
	normalTracking,
} from "#/purchasing/inbox/tracking-numbers";
import {
	externalFulfillment,
	labelSource,
	tiktokOrderLink,
} from "./fulfillment";

// Drop-ships: a supplier ships the order straight to the buyer, so it never
// leaves our shelf. Free of server imports, so pages and the server share
// the rules. The server side is src/shipping/drop-ship.ts.

// The carriers a supplier's tracking can be sent with, as Shopify names them
// (eBay's codes come from the same words).
export const DROP_SHIP_CARRIERS = [
	"UPS",
	"USPS",
	"FedEx",
	"DHL Express",
] as const;
export type DropShipCarrier = (typeof DROP_SHIP_CARRIERS)[number];

const GUESSED = { ups: "UPS", usps: "USPS", fedex: "FedEx" } as const;

// The carrier a tracking number's shape gives away, or null when it doesn't
// (DHL, or a number pasted wrong).
export function carrierOf(number: string): DropShipCarrier | null {
	const guess = guessCarrier(number);
	return guess ? GUESSED[guess] : null;
}

// Spaces and dashes out, as carriers print them in groups.
export const cleanTracking = normalTracking;

// Where a drop-ship's tracking goes: katasync tells Shopify (US orders) and
// eBay itself; every other marketplace takes it on its own page, and the
// order leaves To ship when the next sync sees it shipped there.
export type DropShipTarget =
	| { kind: "tell"; channel: "shopify" | "ebay"; name: string }
	| { kind: "elsewhere"; name: string; url: string | null };

export function dropShipTarget(order: {
	channel: string;
	salesChannel: string | null;
	shipCountry: string | null;
	marketplaceOrderId: string | null;
	externalId: string;
}): DropShipTarget {
	const source = labelSource(order);
	if (source === "shippo" && order.channel === "shopify")
		return { kind: "tell", channel: "shopify", name: "Shopify" };
	if (source === "shippo" && order.channel === "ebay")
		return { kind: "tell", channel: "ebay", name: "eBay" };
	if (source === "tiktok")
		return {
			kind: "elsewhere",
			name: "TikTok",
			url: tiktokOrderLink(order.marketplaceOrderId),
		};
	const external = externalFulfillment(order);
	return external
		? { kind: "elsewhere", name: external.name, url: external.url }
		: { kind: "elsewhere", name: order.channel, url: null };
}
