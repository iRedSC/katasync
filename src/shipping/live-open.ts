import { openUnits } from "#/channels/shopify/fulfillment-units";
import { groupBy } from "#/lib/group-by";
import { labelSource } from "#/orders/fulfillment";
import { unitsToShip } from "#/orders/remaining";
import { destinationOf } from "./destination";
import { ebayOpen, ebayRead } from "./ebay-handoff";
import { Held } from "./packed";

// What can go in a new box is what the marketplace itself says is still
// open, read live as quick ship plans and again under the orders' locks
// just before a label is paid for. katasync's own handoffs and voids change
// that count as they happen, and shipments made outside katasync show up
// in it, so no synced snapshot has to be trusted for it. The synced count
// (order_lines.shipped_quantity) is for showing what shipped, and for
// TikTok, whose label is for the whole order and checked against TikTok's
// own units when bought (tiktok-units.ts).

// Each line's open units by its external id, for one order.
export type OpenReads = {
	// Shopify order GID.
	shopify: (orderId: string) => Promise<Map<string, number>>;
	// eBay order id.
	ebay: (orderId: string) => Promise<Map<string, number>>;
};

export const liveOpenReads: OpenReads = {
	shopify: openUnits,
	ebay: async (orderId) => ebayOpen(await ebayRead(orderId)).open,
};

type OrderRef = {
	name: string;
	channel: string;
	salesChannel: string | null;
	shipCountry: string | null;
	marketplaceOrderId: string | null;
	externalId: string;
};

const NAMES = { shopify: "Shopify", ebay: "eBay" } as const;

// The marketplace read live for this order: the ones katasync buys its own
// labels for. Null for the rest, which go by the synced count.
export function openSource(order: Omit<OrderRef, "name" | "externalId">) {
	if (labelSource(order) !== "shippo") return null;
	const to = destinationOf(order, ["shippo"]);
	return to.kind === "shopify" || to.kind === "ebay" ? to.kind : null;
}

// The marketplace couldn't say what's open, so nothing is packable.
export class OpenUnread extends Error {}

// What's open of each line of this order, or null when it isn't read live.
// Throws OpenUnread when the marketplace doesn't answer in full.
export async function readOpen(order: OrderRef, reads: OpenReads) {
	const source = openSource(order);
	if (!source) return null;
	try {
		return await reads[source](order.externalId);
	} catch (err) {
		// eBay's own holds (a cancellation, a refund) already say why.
		if (err instanceof Held)
			throw new OpenUnread(`${order.name}: ${err.message}`);
		console.error(`Reading what ${order.name} has open`, err);
		throw new OpenUnread(
			`${order.name}: ${NAMES[source]} didn't say what's left to ship. Try again`,
		);
	}
}

type Line = {
	orderId: number;
	externalId: string;
	quantity: number;
	shippedQuantity: number | null;
	// Units in this order's live dispatch not yet handed off.
	unsent: number;
};

// Each line with how many of it can go in a new box: what's open less what
// a label not yet handed off already holds. Live, what the marketplace says
// is open, never more than was sold. Otherwise the synced count's remaining;
// an order whose count is unknown has nothing packable (whyNotTogether
// refuses it first).
export function packableOf<L extends Line>(
	lines: L[],
	open: Map<string, number> | null,
): (L & { packable: number })[] {
	const unknown =
		open === null &&
		lines.some((l) => l.quantity > 0 && l.shippedQuantity === null);
	return lines.map((l) => {
		const left = unknown
			? 0
			: open
				? Math.min(open.get(l.externalId) ?? 0, l.quantity)
				: (unitsToShip(l) ?? 0);
		return { ...l, packable: Math.max(0, left - l.unsent) };
	});
}

// packableOf for the lines of several orders, each order read once, all at
// once. Lines keep their order.
export async function withPackable<L extends Line>(
	orders: (OrderRef & { id: number })[],
	lines: L[],
	reads: OpenReads,
): Promise<(L & { packable: number })[]> {
	const open = new Map(
		await Promise.all(
			orders.map(async (o) => [o.id, await readOpen(o, reads)] as const),
		),
	);
	return [...groupBy(lines, (l) => l.orderId)].flatMap(([id, of]) => {
		const read = open.get(id);
		if (read === undefined) throw new Error("A line's order wasn't read");
		return packableOf(of, read);
	});
}
