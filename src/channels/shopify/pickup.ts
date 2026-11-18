import { type } from "arktype";
import { shopifyQuery, userErrors } from "./client";
import { readShopifyOpen, SHIPPABLE, unitsOpen } from "./fulfillment-units";

const prepared = type({
	fulfillmentOrderLineItemsPreparedForPickup: { userErrors },
});

// Units of each line Shopify can hand over now, by line ID, and the
// fulfillment orders holding them. Held and scheduled ones wait, as they
// would for a box.
export async function pickupOpen(orderId: string) {
	const open = await readShopifyOpen(orderId, SHIPPABLE);
	const holding = open.fulfillmentOrders.filter((f) =>
		f.items.some((i) => i.remaining > 0),
	);
	return {
		units: unitsOpen(holding),
		fulfillmentOrders: holding.map((f) => f.id),
	};
}

// Tells Shopify a local pickup is set aside, and Shopify emails the buyer to
// come get it. Every fulfillment order with units open goes, whole.
export async function shopifyReadyForPickup(orderId: string) {
	const { fulfillmentOrders } = await pickupOpen(orderId);
	if (fulfillmentOrders.length === 0)
		throw new Error("Shopify shows nothing left to hand over");
	const { fulfillmentOrderLineItemsPreparedForPickup: result } =
		prepared.assert(
			await shopifyQuery(
				`mutation($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
					fulfillmentOrderLineItemsPreparedForPickup(input: $input) { userErrors { field message } }
				}`,
				{
					input: {
						lineItemsByFulfillmentOrder: fulfillmentOrders.map((id) => ({
							fulfillmentOrderId: id,
						})),
					},
				},
			),
		);
	if (result.userErrors.length > 0)
		throw new Error(
			`Shopify refused: ${result.userErrors.map((e) => e.message).join("; ")}`,
		);
}
