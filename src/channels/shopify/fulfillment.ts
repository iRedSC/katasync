import { type } from "arktype";
import { assertFits, driftOf, type Fit, unmappable } from "#/shipping/packed";
import { shopifyQuery, userErrors } from "./client";
import {
	allocate,
	fulfillmentLines,
	readShopifyOpen,
	TOO_MANY_SHIPMENTS,
	unitsOpen,
} from "./fulfillment-units";

const fulfillmentCreated = type({
	fulfillmentCreate: {
		fulfillment: type({ id: "string" }).or("null"),
		userErrors,
	},
});

// Marks what was packed as shipped with this tracking (one number per box),
// and has Shopify email the customer. Returns Shopify's fulfillment id,
// which voiding needs, and how many units the order still has to ship
// after it. Needs write_merchant_managed_fulfillment_orders.
//
// packed is each line item's quantity in the box, checked against what
// Shopify still has to ship (on hold and scheduled too) by fit (see
// packed.ts): exactly for a whole order, within for one shipment of
// several. If it doesn't fit, it throws ContentsChanged and fulfills
// nothing; the fulfillment then names every line's quantity, so nothing
// added in between ships with it. Units on hold or scheduled block it only
// when the box needs them, and the box must come from one location
// (allocate), as the purchase checked.
//
// Safe to repeat: a fulfillment already carrying these tracking numbers
// (an earlier try got through) is returned instead of a second one, but
// only if it shipped exactly what was packed, whatever the fit, so a retry
// never takes an earlier shipment of other units for this one. Anything
// Shopify shows that katasync can't be sure of is held for a person rather
// than guessed at.
//
// tracking null ships it with no tracking at all (a drop-ship whose supplier
// never sent one). Nothing then tells a repeat from a first try, so a repeat
// finds nothing left open and throws instead of shipping twice.
export async function shopifyFulfill(
	orderId: string,
	tracking: {
		company: string;
		boxes: { number: string; url: string | null }[];
	} | null,
	packed: Map<string, number>,
	fit: Fit,
): Promise<{ fulfillmentId: string; remaining: number }> {
	if (tracking?.boxes.length === 0) throw new Error("No tracking to send");
	const numbers = tracking?.boxes.map((b) => b.number) ?? [];
	// Read whole (readShopifyOpen), so a purchase and its handoff agree on
	// what's open and where (allocate).
	const order = await readShopifyOpen(orderId);
	const open = unitsOpen(order.fulfillmentOrders);
	const titles = new Map(
		order.fulfillmentOrders.flatMap((f) =>
			f.items.map((i) => [i.line, i.name] as const),
		),
	);
	const remaining = [...open.values()].reduce((sum, n) => sum + n, 0);
	if (order.fulfillments === "too many") throw unmappable(TOO_MANY_SHIPMENTS);
	for (const f of order.fulfillments) {
		if (f.status === "CANCELLED") continue;
		const has = new Set(f.numbers);
		const matching = numbers.filter((n) => has.has(n));
		if (matching.length === 0) continue;
		if (matching.length < numbers.length) {
			throw unmappable(
				`Shopify already has a fulfillment with ${matching.join(", ")} but not ${numbers.filter((n) => !has.has(n)).join(", ")}; fix it in Shopify`,
			);
		}
		if (driftOf(packed, await fulfillmentLines(f.id), titles).length > 0) {
			throw unmappable(
				"Shopify already has this tracking on a fulfillment of other items; fix it in Shopify",
			);
		}
		return { fulfillmentId: f.id, remaining };
	}
	assertFits(fit, packed, open, titles);
	const items = allocate(order, packed);
	const allocated = items
		.flatMap((f) => f.fulfillmentOrderLineItems)
		.reduce((sum, i) => sum + i.quantity, 0);
	const { fulfillmentCreate } = fulfillmentCreated.assert(
		await shopifyQuery(
			"mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }",
			{
				fulfillment: {
					lineItemsByFulfillmentOrder: items,
					...(tracking
						? {
								trackingInfo: {
									company: tracking.company,
									numbers,
									// Shopify pairs urls with numbers by position, so every
									// box needs one or none do.
									...(tracking.boxes.every((b) => b.url)
										? { urls: tracking.boxes.map((b) => b.url) }
										: {}),
								},
							}
						: {}),
					notifyCustomer: true,
				},
			},
		),
	);
	if (
		fulfillmentCreate.userErrors.length > 0 ||
		!fulfillmentCreate.fulfillment
	) {
		throw new Error(
			`Shopify refused: ${fulfillmentCreate.userErrors.map((e) => e.message).join("; ")}`,
		);
	}
	// What Shopify still has to ship once this fulfillment is in: what was
	// open, less what it took.
	return {
		fulfillmentId: fulfillmentCreate.fulfillment.id,
		remaining: remaining - allocated,
	};
}

const fulfillmentCancelled = type({
	fulfillmentCancel: { userErrors },
});

// Undoes shopifyFulfill after a label is voided: that fulfillment's units go
// back to unfulfilled on Shopify; other shipments of the order stay.
export async function shopifyCancelFulfillment(fulfillmentId: string) {
	const { fulfillmentCancel } = fulfillmentCancelled.assert(
		await shopifyQuery(
			"mutation($id: ID!) { fulfillmentCancel(id: $id) { userErrors { field message } } }",
			{ id: fulfillmentId },
		),
	);
	if (fulfillmentCancel.userErrors.length > 0) {
		throw new Error(
			`Shopify refused: ${fulfillmentCancel.userErrors.map((e) => e.message).join("; ")}`,
		);
	}
}
