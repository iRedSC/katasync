import { type } from "arktype";
import { assertUnchanged, driftOf, unmappable } from "#/shipping/packed";
import { shopifyQuery, userErrors } from "./client";

const morePages = { pageInfo: { hasNextPage: "boolean" } } as const;

const openFulfillmentOrders = type({
	order: type({
		fulfillmentOrders: {
			...morePages,
			nodes: type({
				id: "string",
				status: "string",
				lineItems: {
					...morePages,
					nodes: type({
						id: "string",
						remainingQuantity: "number.integer >= 0",
						lineItem: { id: "string", name: "string" },
					}).array(),
				},
			}).array(),
		},
		fulfillments: type({
			id: "string",
			status: "string",
			trackingInfo: type({ number: "string | null" }).array(),
			fulfillmentLineItems: {
				...morePages,
				nodes: type({
					quantity: "number.integer",
					lineItem: { id: "string" },
				}).array(),
			},
		}).array(),
	}).or("null"),
});

const fulfillmentCreated = type({
	fulfillmentCreate: {
		fulfillment: type({ id: "string" }).or("null"),
		userErrors,
	},
});

const MOST_FULFILLMENTS = 10;

const OPEN_QUERY = `query($id: ID!) { order(id: $id) {
	fulfillmentOrders(first: 5) { pageInfo { hasNextPage } nodes { id status
		lineItems(first: 50) { pageInfo { hasNextPage } nodes { id remainingQuantity lineItem { id name } } }
	} }
	fulfillments(first: ${MOST_FULFILLMENTS}) { id status trackingInfo { number }
		fulfillmentLineItems(first: 50) { pageInfo { hasNextPage } nodes { quantity lineItem { id } } }
	}
} }`;

const FULFILLABLE = new Set(["OPEN", "IN_PROGRESS"]);
const DONE = new Set(["CANCELLED", "CLOSED"]);

// Marks what was packed as shipped with this tracking (one number per box),
// and has Shopify email the customer. Returns Shopify's fulfillment id,
// which voiding needs, and how many units the order still has to ship
// after it. Needs write_merchant_managed_fulfillment_orders.
//
// packed is each line item's quantity in the box. Everything Shopify still
// has to ship (on hold and scheduled too) must be exactly that, or it
// throws ContentsChanged and fulfills nothing; the fulfillment then names
// every line's quantity, so nothing added in between ships with it.
//
// Safe to repeat: a fulfillment already carrying these tracking numbers
// (an earlier try got through) is returned instead of a second one, but
// only if it shipped exactly what was packed. Anything Shopify shows that
// katasync can't be sure of is held for a person rather than guessed at.
export async function shopifyFulfill(
	orderId: string,
	tracking: {
		company: string;
		boxes: { number: string; url: string | null }[];
	},
	packed: Map<string, number>,
): Promise<{ fulfillmentId: string; remaining: number }> {
	if (tracking.boxes.length === 0) throw new Error("No tracking to send");
	const numbers = tracking.boxes.map((b) => b.number);
	const { order } = openFulfillmentOrders.assert(
		await shopifyQuery(OPEN_QUERY, { id: orderId }),
	);
	if (!order) throw new Error("Shopify has no such order");
	const live = order.fulfillmentOrders.nodes.filter((f) => !DONE.has(f.status));
	if (
		order.fulfillmentOrders.pageInfo.hasNextPage ||
		live.some((f) => f.lineItems.pageInfo.hasNextPage) ||
		order.fulfillments.length >= MOST_FULFILLMENTS
	) {
		throw unmappable(
			"Too much on this order for katasync to check; fulfill it in Shopify",
		);
	}
	const open = new Map<string, number>();
	const titles = new Map<string, string>();
	for (const item of live.flatMap((f) => f.lineItems.nodes)) {
		const id = item.lineItem.id;
		titles.set(id, item.lineItem.name);
		if (item.remainingQuantity > 0)
			open.set(id, (open.get(id) ?? 0) + item.remainingQuantity);
	}
	const remaining = [...open.values()].reduce((sum, n) => sum + n, 0);
	for (const f of order.fulfillments) {
		if (f.status === "CANCELLED") continue;
		const has = new Set(f.trackingInfo.map((t) => t.number));
		const matching = numbers.filter((n) => has.has(n));
		if (matching.length === 0) continue;
		if (matching.length < numbers.length) {
			throw unmappable(
				`Shopify already has a fulfillment with ${matching.join(", ")} but not ${numbers.filter((n) => !has.has(n)).join(", ")}; fix it in Shopify`,
			);
		}
		const shipped = new Map<string, number>();
		for (const item of f.fulfillmentLineItems.nodes) {
			const id = item.lineItem.id;
			shipped.set(id, (shipped.get(id) ?? 0) + item.quantity);
		}
		if (
			f.fulfillmentLineItems.pageInfo.hasNextPage ||
			driftOf(packed, shipped, titles).length > 0
		) {
			throw unmappable(
				"Shopify already has this tracking on a fulfillment of other items; fix it in Shopify",
			);
		}
		return { fulfillmentId: f.id, remaining };
	}
	assertUnchanged(packed, open, titles);
	const fulfillable = live.filter((f) => FULFILLABLE.has(f.status));
	const items = exactly(fulfillable, packed);
	const allocated = items
		.flatMap((f) => f.fulfillmentOrderLineItems)
		.reduce((sum, i) => sum + i.quantity, 0);
	if (allocated !== remaining) {
		throw unmappable(
			"Some of it is on hold or scheduled in Shopify; release it there, then send again",
		);
	}
	const { fulfillmentCreate } = fulfillmentCreated.assert(
		await shopifyQuery(
			"mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }",
			{
				fulfillment: {
					lineItemsByFulfillmentOrder: items,
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
	return { fulfillmentId: fulfillmentCreate.fulfillment.id, remaining: 0 };
}

type OpenOrder = (typeof openFulfillmentOrders.infer)["order"] & {};

// Each fulfillment order's line items with how many of each to fulfill, the
// packed quantity of a line shared out across the fulfillment orders that
// hold it.
function exactly(
	open: OpenOrder["fulfillmentOrders"]["nodes"],
	packed: Map<string, number>,
) {
	const left = new Map(packed);
	return open.flatMap((f) => {
		const items = f.lineItems.nodes.flatMap((item) => {
			const want = left.get(item.lineItem.id) ?? 0;
			const quantity = Math.min(want, item.remainingQuantity);
			if (quantity === 0) return [];
			left.set(item.lineItem.id, want - quantity);
			return [{ id: item.id, quantity }];
		});
		return items.length > 0
			? [{ fulfillmentOrderId: f.id, fulfillmentOrderLineItems: items }]
			: [];
	});
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
