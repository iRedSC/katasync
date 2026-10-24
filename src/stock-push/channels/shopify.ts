import { type } from "arktype";
import { shopifyQuery } from "#/channels/shopify/client";
import type { Found, StockChannel } from "../channel";

const target = type({ inventoryItemId: "string", locationId: "string" });
type Target = typeof target.infer;

const primaryLocation = type({
	locations: {
		nodes: type({ id: "string", name: "string", isPrimary: "boolean" }).array(),
	},
});

const stockPage = type({
	productVariants: {
		pageInfo: { hasNextPage: "boolean", "endCursor?": "string | null" },
		nodes: type({
			id: "string",
			inventoryItem: {
				id: "string",
				tracked: "boolean",
				inventoryLevel: type({
					quantities: type({
						name: "string",
						quantity: "number.integer",
					}).array(),
				}).or("null"),
			},
		}).array(),
	},
});

const STOCK_QUERY = `
query Stock($cursor: String, $location: ID!) {
	productVariants(first: 100, after: $cursor) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id
			inventoryItem {
				id tracked
				inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } }
			}
		}
	}
}`;

// Each variant's stock at one location, as a stock read sees it.
export function shopifyStockFound(
	node: (typeof stockPage.infer)["productVariants"]["nodes"][number],
	location: { id: string; name: string },
): Found<Target> {
	const item = node.inventoryItem;
	if (!item.tracked)
		return {
			state: "unpushable",
			reason: "Shopify doesn't track this variant's inventory",
		};
	if (!item.inventoryLevel)
		return {
			state: "unpushable",
			reason: `it isn't stocked at ${location.name} in Shopify`,
		};
	const available = item.inventoryLevel.quantities.find(
		(q) => q.name === "available",
	);
	return {
		state: "ready",
		target: { inventoryItemId: item.id, locationId: location.id },
		shows: available?.quantity ?? null,
	};
}

async function read() {
	const { locations } = primaryLocation.assert(
		await shopifyQuery(
			"{ locations(first: 50) { nodes { id name isPrimary } } }",
			{},
		),
	);
	const location = locations.nodes.find((l) => l.isPrimary);
	if (!location) throw new Error("Shopify has no primary location");
	const found = new Map<string, Found<Target>>();
	let cursor: string | null = null;
	do {
		const page = stockPage.assert(
			await shopifyQuery(STOCK_QUERY, { cursor, location: location.id }),
		);
		for (const node of page.productVariants.nodes)
			found.set(node.id, shopifyStockFound(node, location));
		cursor = page.productVariants.pageInfo.hasNextPage
			? (page.productVariants.pageInfo.endCursor ?? null)
			: null;
	} while (cursor);
	return found;
}

export const shopifyStock: StockChannel<Target> = {
	name: "Shopify",
	target,
	read,
};
