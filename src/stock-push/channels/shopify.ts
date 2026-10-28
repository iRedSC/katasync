import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { shopifyQuery } from "#/channels/shopify/client";
import { chunks, type Found, type StockChannel } from "../channel";

// Shopify keeps stock per location. katasync sets "available" at the shop's
// primary location, the one labels ship from (src/channels/shopify/ship-from.ts);
// other locations, like a storefront, are left alone. Needs read_inventory
// and write_inventory.

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
			byDesign: true,
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

const setResult = type({
	inventorySetQuantities: {
		userErrors: type({
			field: "string[] | null",
			message: "string",
		}).array(),
	},
});

const SET_MUTATION = `
mutation Set($input: InventorySetQuantitiesInput!, $key: String!) {
	inventorySetQuantities(input: $input) @idempotent(key: $key) {
		userErrors { field message }
	}
}`;

// The quantity a user error is about, from a field like
// ["input", "quantities", "3", "quantity"].
export function errorIndex(field: string[] | null): number | null {
	const at = field?.indexOf("quantities") ?? -1;
	const index = at >= 0 ? Number(field?.[at + 1]) : Number.NaN;
	return Number.isInteger(index) ? index : null;
}

// A refused call changes nothing, so the quantities Shopify didn't object to
// are sent again without the ones it did.
async function write(writes: Parameters<StockChannel<Target>["write"]>[0]) {
	const failures = new Map<string, string>();
	for (const part of chunks(writes, 100)) {
		let batch = part;
		for (let round = 1; batch.length > 0; round++) {
			if (round > 3) {
				for (const w of batch)
					failures.set(
						w.externalId,
						"Shopify kept refusing the quantities sent with it",
					);
				break;
			}
			const { inventorySetQuantities: r } = setResult.assert(
				await shopifyQuery(SET_MUTATION, {
					key: randomUUID(),
					input: {
						name: "available",
						reason: "correction",
						referenceDocumentUri: "gid://katasync/StockPush/sync",
						quantities: batch.map((w) => ({
							inventoryItemId: w.target.inventoryItemId,
							locationId: w.target.locationId,
							quantity: w.quantity,
							changeFromQuantity: null,
						})),
					},
				}),
			);
			if (r.userErrors.length === 0) break;
			const indexed = r.userErrors.map((e) => ({ e, i: errorIndex(e.field) }));
			const general = indexed.find(({ i }) => i === null || !batch[i]);
			if (general) {
				// Not about one quantity, so none of them went through.
				for (const w of batch) failures.set(w.externalId, general.e.message);
				break;
			}
			for (const { e, i } of indexed)
				failures.set(batch[i as number].externalId, e.message);
			const refused = new Set(indexed.map(({ i }) => i));
			batch = batch.filter((_, i) => !refused.has(i));
		}
	}
	return failures;
}

export const shopifyStock: StockChannel<Target> = {
	name: "Shopify",
	target,
	read,
	write,
};
