import { type } from "arktype";
import { unmappable } from "#/shipping/packed";
import { shopifyQuery } from "./client";

const shippedPage = type({
	order: {
		fulfillments: type({
			status: "string",
			fulfillmentLineItems: {
				pageInfo: { hasNextPage: "boolean" },
				nodes: type({
					quantity: "number.integer",
					lineItem: { id: "string" },
				}).array(),
			},
		}).array(),
	},
});

// Order.fulfillments is a plain list, not a page: asking for this many and
// getting them all back means there may be more.
const MOST_FULFILLMENTS = 50;

const SHIPPED_QUERY = `
query Shipped($id: ID!) {
	order(id: $id) {
		fulfillments(first: ${MOST_FULFILLMENTS}) {
			status
			fulfillmentLineItems(first: 250) { pageInfo { hasNextPage } nodes { quantity lineItem { id } } }
		}
	}
}`;

// Fulfillments that never went out.
const notShipped = new Set(["CANCELLED", "ERROR", "FAILURE"]);

export type ShippedUnits = {
	// Units of each line in any fulfillment that didn't fail, by line ID:
	// what line quantities count as gone (shopifyLineQuantity).
	sent: Map<string, number>;
	// Only those in successful fulfillments: what the order shows shipped.
	succeeded: Map<string, number>;
};

// Units of each line that have shipped, or null when the order has more
// fulfillments or lines than one read returns, so a short count is never
// taken for the whole.
export async function shippedUnits(
	orderId: string,
): Promise<ShippedUnits | null> {
	const page = shippedPage.assert(
		await shopifyQuery(SHIPPED_QUERY, { id: orderId }),
	);
	const { fulfillments } = page.order;
	if (
		fulfillments.length >= MOST_FULFILLMENTS ||
		fulfillments.some((f) => f.fulfillmentLineItems.pageInfo.hasNextPage)
	)
		return null;
	const units: ShippedUnits = { sent: new Map(), succeeded: new Map() };
	const add = (to: Map<string, number>, id: string, n: number) =>
		to.set(id, (to.get(id) ?? 0) + n);
	for (const f of fulfillments) {
		if (notShipped.has(f.status)) continue;
		for (const item of f.fulfillmentLineItems.nodes) {
			add(units.sent, item.lineItem.id, item.quantity);
			if (f.status === "SUCCESS")
				add(units.succeeded, item.lineItem.id, item.quantity);
		}
	}
	return units;
}

const fulfillmentOrdersPage = type({
	order: type({
		"fulfillments?": type({
			id: "string",
			status: "string",
			trackingInfo: type({ number: "string | null" }).array(),
		}).array(),
		fulfillmentOrders: {
			pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
			nodes: type({
				id: "string",
				status: "string",
				assignedLocation: {
					name: "string",
					location: type({ id: "string" }).or("null"),
				},
			}).array(),
		},
	}).or("null"),
});

const itemsPage = type({
	node: {
		lineItems: {
			pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
			nodes: type({
				id: "string",
				remainingQuantity: "number.integer >= 0",
				lineItem: { id: "string", name: "string" },
			}).array(),
		},
	},
});

const fulfillmentLinesPage = type({
	node: {
		fulfillmentLineItems: {
			pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
			nodes: type({
				quantity: "number.integer",
				lineItem: { id: "string" },
			}).array(),
		},
	},
});

// Order.fulfillments is a plain list, not a page: asking for this many and
// getting them all back means there may be more, so the read refuses it.
const MOST_SHIPMENTS = 100;

// One line item of a fulfillment order: its own id (what a fulfillment
// names), the order line it's of, and what's still to ship of it.
export type FulfillmentOrderItem = {
	id: string;
	line: string;
	name: string;
	remaining: number;
};

// A fulfillment order: some of an order's units, assigned to one location.
export type FulfillmentOrder = {
	id: string;
	status: string;
	// The assigned location's id, or its name if Shopify no longer has it.
	location: string;
	items: FulfillmentOrderItem[];
};

// A shipment Shopify has for the order, with its tracking numbers.
export type ShopifyFulfillment = {
	id: string;
	status: string;
	numbers: string[];
};

// What Shopify still has to ship of an order, by fulfillment order, and
// every shipment it has. Read whole: each page to its end, a missing cursor
// throwing, so a short count is never taken for the whole. Shipments are a
// plain list, not pages: "too many" when there may be more than one read
// returns, and nothing may then be shipped through katasync (allocate).
export type ShopifyOpen = {
	fulfillmentOrders: FulfillmentOrder[];
	fulfillments: ShopifyFulfillment[] | "too many";
};

// Every fulfillment order not cancelled or closed counts, on hold and
// scheduled too, unless only names the statuses to read.
export async function readShopifyOpen(
	orderId: string,
	only?: ReadonlySet<string>,
): Promise<ShopifyOpen> {
	const open: ShopifyOpen = { fulfillmentOrders: [], fulfillments: [] };
	let cursor: string | null = null;
	let first = true;
	do {
		const { order } = fulfillmentOrdersPage.assert(
			await shopifyQuery(
				`query($id: ID!, $cursor: String, $first: Boolean!) {
				order(id: $id) {
					fulfillments(first: ${MOST_SHIPMENTS}) @include(if: $first) { id status trackingInfo { number } }
					fulfillmentOrders(first: 50, after: $cursor) {
						pageInfo { hasNextPage endCursor }
						nodes { id status assignedLocation { name location { id } } }
					}
				}
			}`,
				{ id: orderId, cursor, first },
			),
		);
		if (!order) throw new Error("Shopify has no such order");
		if (first) {
			const fulfillments = order.fulfillments ?? [];
			open.fulfillments =
				fulfillments.length >= MOST_SHIPMENTS
					? "too many"
					: fulfillments.map((f) => ({
							id: f.id,
							status: f.status,
							numbers: f.trackingInfo.flatMap((t) =>
								t.number ? [t.number] : [],
							),
						}));
			first = false;
		}
		for (const f of order.fulfillmentOrders.nodes) {
			if (DONE.has(f.status)) continue;
			if (only && !only.has(f.status)) continue;
			open.fulfillmentOrders.push({
				id: f.id,
				status: f.status,
				location: f.assignedLocation.location?.id ?? f.assignedLocation.name,
				items: await itemsOf(f.id),
			});
		}
		cursor = nextCursor(order.fulfillmentOrders.pageInfo, "fulfillment-orders");
	} while (cursor);
	return open;
}

async function itemsOf(fulfillmentOrderId: string) {
	const items: FulfillmentOrderItem[] = [];
	let cursor: string | null = null;
	do {
		const { node } = itemsPage.assert(
			await shopifyQuery(
				`query($id: ID!, $cursor: String) {
				node(id: $id) { ... on FulfillmentOrder { lineItems(first: 100, after: $cursor) {
					pageInfo { hasNextPage endCursor } nodes { id remainingQuantity lineItem { id name } }
				} } }
			}`,
				{ id: fulfillmentOrderId, cursor },
			),
		);
		for (const item of node.lineItems.nodes)
			items.push({
				id: item.id,
				line: item.lineItem.id,
				name: item.lineItem.name,
				remaining: item.remainingQuantity,
			});
		cursor = nextCursor(node.lineItems.pageInfo, "remaining-items");
	} while (cursor);
	return items;
}

// Units of each line in one fulfillment, every page read.
export async function fulfillmentLines(fulfillmentId: string) {
	const lines = new Map<string, number>();
	let cursor: string | null = null;
	do {
		const { node } = fulfillmentLinesPage.assert(
			await shopifyQuery(
				`query($id: ID!, $cursor: String) {
				node(id: $id) { ... on Fulfillment { fulfillmentLineItems(first: 100, after: $cursor) {
					pageInfo { hasNextPage endCursor } nodes { quantity lineItem { id } }
				} } }
			}`,
				{ id: fulfillmentId, cursor },
			),
		);
		for (const item of node.fulfillmentLineItems.nodes) {
			const id = item.lineItem.id;
			lines.set(id, (lines.get(id) ?? 0) + item.quantity);
		}
		cursor = nextCursor(
			node.fulfillmentLineItems.pageInfo,
			"fulfillment-lines",
		);
	} while (cursor);
	return lines;
}

function nextCursor(
	page: { hasNextPage: boolean; endCursor: string | null },
	what: string,
) {
	if (!page.hasNextPage) return null;
	if (!page.endCursor) throw new Error(`Shopify omitted the ${what} cursor`);
	return page.endCursor;
}

const DONE = new Set(["CANCELLED", "CLOSED"]);

// Units of each line still to ship on these fulfillment orders, by line ID.
export function unitsOpen(fulfillmentOrders: FulfillmentOrder[]) {
	const open = new Map<string, number>();
	for (const item of fulfillmentOrders.flatMap((f) => f.items))
		if (item.remaining > 0)
			open.set(item.line, (open.get(item.line) ?? 0) + item.remaining);
	return open;
}

// Units of each line Shopify still has to ship, by line ID, summed across
// fulfillment orders, held and scheduled ones too.
export const remainingUnits = async (orderId: string) =>
	unitsOpen((await readShopifyOpen(orderId)).fulfillmentOrders);

// Fulfillment orders katasync may fulfill now. On hold and scheduled ones
// wait.
export const SHIPPABLE: ReadonlySet<string> = new Set(["OPEN", "IN_PROGRESS"]);

// What quick ship packs from and a purchase checks: the fulfillment orders
// katasync may fulfill now, and every shipment.
export const shippableNow = (orderId: string) =>
	readShopifyOpen(orderId, SHIPPABLE);

// The same, as read from one location: for stand-ins in tests and anything
// that has only counts.
export const atOneLocation = (open: Map<string, number>): ShopifyOpen => ({
	fulfillmentOrders: [
		{
			id: "gid://shopify/FulfillmentOrder/0",
			status: "OPEN",
			location: "gid://shopify/Location/0",
			items: [...open].map(([line, remaining]) => ({
				id: `${line}/item`,
				line,
				name: line,
				remaining,
			})),
		},
	],
	fulfillments: [],
});

export const TOO_MANY_SHIPMENTS =
	"This order has too many shipments for katasync to check; ship it in Shopify";
export const SPLIT_LOCATIONS =
	"These items are at different Shopify locations. Ship it in Shopify, or move them to one location there";
export const NOT_RELEASED =
	"Some of it is on hold or scheduled in Shopify; release it there, then send again";

// The line items of each fulfillment order to ship this box with, all at
// one location, as one fulfillment needs.
export type Allocation = {
	fulfillmentOrderId: string;
	fulfillmentOrderLineItems: { id: string; quantity: number }[];
}[];

// Shares each line's packed quantity out across the fulfillment orders that
// hold it, in Shopify's order. null when they don't hold all of it.
function share(
	fulfillmentOrders: FulfillmentOrder[],
	packed: Map<string, number>,
) {
	const left = new Map(packed);
	const items = fulfillmentOrders.flatMap((f) => {
		const of = f.items.flatMap((item) => {
			const want = left.get(item.line) ?? 0;
			const quantity = Math.min(want, item.remaining);
			if (quantity === 0) return [];
			left.set(item.line, want - quantity);
			return [{ id: item.id, quantity }];
		});
		return of.length > 0
			? [{ fulfillmentOrderId: f.id, fulfillmentOrderLineItems: of }]
			: [];
	});
	return [...left.values()].every((n) => n === 0) ? items : null;
}

// How to ship the packed units (by line ID) in one Shopify fulfillment:
// from fulfillment orders katasync may fulfill now, at the first location
// that holds them all, with room for one more shipment so a retry can still
// find it. Throws unmappable, before anything is paid for or sent, when it
// can't. A purchase and its handoff both ask this, so Shopify never refuses
// a box katasync already bought a label for.
export function allocate(
	open: ShopifyOpen,
	packed: Map<string, number>,
): Allocation {
	if (
		open.fulfillments === "too many" ||
		open.fulfillments.length + 1 >= MOST_SHIPMENTS
	)
		throw unmappable(TOO_MANY_SHIPMENTS);
	const now = open.fulfillmentOrders.filter((f) => SHIPPABLE.has(f.status));
	for (const location of new Set(now.map((f) => f.location))) {
		const items = share(
			now.filter((f) => f.location === location),
			packed,
		);
		if (items) return items;
	}
	throw unmappable(share(now, packed) ? SPLIT_LOCATIONS : NOT_RELEASED);
}
