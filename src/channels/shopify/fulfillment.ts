import { type } from "arktype";
import { shopifyQuery, userErrors } from "./client";

const openFulfillmentOrders = type({
	order: type({
		fulfillmentOrders: {
			nodes: type({ id: "string", status: "string" }).array(),
		},
		fulfillments: type({
			id: "string",
			status: "string",
			trackingInfo: type({ number: "string | null" }).array(),
		}).array(),
	}).or("null"),
});

const fulfillmentCreated = type({
	fulfillmentCreate: {
		fulfillment: type({ id: "string" }).or("null"),
		userErrors,
	},
});

// Marks everything still open on the order as shipped with this tracking
// (one number per box), and has Shopify email the customer. Returns
// Shopify's fulfillment id, which voiding needs. Safe to repeat: if these
// tracking numbers are already on the order (an earlier try got through),
// that fulfillment is returned instead of a second one. Needs
// write_merchant_managed_fulfillment_orders.
export async function shopifyFulfill(
	orderId: string,
	tracking: {
		company: string;
		boxes: { number: string; url: string | null }[];
	},
) {
	if (tracking.boxes.length === 0) throw new Error("No tracking to send");
	const numbers = tracking.boxes.map((b) => b.number);
	const { order } = openFulfillmentOrders.assert(
		await shopifyQuery(
			"query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status } } fulfillments(first: 50) { id status trackingInfo { number } } } }",
			{ id: orderId },
		),
	);
	if (!order) throw new Error("Shopify has no such order");
	// Only a fulfillment carrying every one of these numbers is this
	// shipment sent before; one carrying just some was made another way and
	// needs a person to look.
	for (const f of order.fulfillments) {
		if (f.status === "CANCELLED") continue;
		const has = new Set(f.trackingInfo.map((t) => t.number));
		const matching = numbers.filter((n) => has.has(n));
		if (matching.length === numbers.length) return f.id;
		if (matching.length > 0) {
			throw new Error(
				`Shopify already has a fulfillment with ${matching.join(", ")} but not ${numbers.filter((n) => !has.has(n)).join(", ")}; fix it in Shopify`,
			);
		}
	}
	const open = order.fulfillmentOrders.nodes.filter((f) =>
		["OPEN", "IN_PROGRESS"].includes(f.status),
	);
	if (open.length === 0) {
		throw new Error("Shopify shows nothing left to ship on this order");
	}
	const { fulfillmentCreate } = fulfillmentCreated.assert(
		await shopifyQuery(
			"mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }",
			{
				fulfillment: {
					lineItemsByFulfillmentOrder: open.map((f) => ({
						fulfillmentOrderId: f.id,
					})),
					trackingInfo: {
						company: tracking.company,
						numbers,
						// Shopify pairs urls with numbers by position, so every box
						// needs one or none do.
						...(tracking.boxes.every((b) => b.url)
							? { urls: tracking.boxes.map((b) => b.url) }
							: {}),
					},
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
	return fulfillmentCreate.fulfillment.id;
}

const fulfillmentCancelled = type({
	fulfillmentCancel: { userErrors },
});

// Undoes shopifyFulfill after a label is voided: the order goes back to
// unfulfilled on Shopify.
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
