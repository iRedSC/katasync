import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import {
	autoMapListings,
	cleanTitle,
	createProductNamed as createProduct,
	mapListing,
} from "#/channels/listings";
import { type StockLocations, stockLocations } from "#/channels/stores";
import { unmatchedListings } from "#/channels/unmatched";
import type { Db } from "#/db/client";
import {
	listings,
	orderLines,
	orders,
	productAliases,
	products,
	stores,
} from "#/db/schema";
import type { Channel } from "#/diagnostics/runs";
import { costOf, orderTakesStock, resolveProduct, takeStock } from "./ingest";

type Pending = {
	line: typeof orderLines.$inferSelect;
	order: Pick<
		typeof orders.$inferSelect,
		"name" | "placedAt" | "cancelledAt" | "fulfilledByChannel" | "soldInStore"
	>;
	store: Pick<typeof stores.$inferSelect, "id" | "stockFrom">;
};

const pendingColumns = {
	line: orderLines,
	order: {
		name: orders.name,
		placedAt: orders.placedAt,
		cancelledAt: orders.cancelledAt,
		fulfilledByChannel: orders.fulfilledByChannel,
		soldInStore: orders.soldInStore,
	},
	store: { id: stores.id, stockFrom: stores.stockFrom },
};

// Gives each line its product and cost, and takes stock now for lines on
// orders that take it. A line never takes stock twice.
async function catchUp(
	tx: Db,
	pending: (Pending & { productId: number })[],
	from: StockLocations,
): Promise<string[]> {
	const problems: string[] = [];
	for (const { line, productId, order, store } of pending) {
		await tx
			.update(orderLines)
			.set({ productId, unitCost: await costOf(tx, productId) })
			.where(eq(orderLines.id, line.id));
		if (line.saleBatchId || !orderTakesStock(store, order)) continue;
		const problem = await takeStock(tx, { ...line, productId }, order, from);
		if (problem) problems.push(problem);
	}
	return problems;
}

// After listings get a product, catch up the orders that already sold them.
// Safe to repeat.
export async function applyListingsToOrders(
	db: Db,
	listingIds: number[],
	from: StockLocations,
): Promise<{ lines: number; problems: string[] }> {
	if (listingIds.length === 0) return { lines: 0, problems: [] };
	return db.transaction(async (tx) => {
		const pending = await tx
			.select({ ...pendingColumns, productId: listings.productId })
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.innerJoin(
				listings,
				and(
					eq(listings.storeId, orders.storeId),
					eq(listings.externalId, orderLines.listingExternalId),
				),
			)
			.where(
				and(inArray(listings.id, listingIds), isNull(orderLines.productId)),
			)
			.for("update", { of: orderLines });
		const found = pending.flatMap((p) =>
			p.productId === null ? [] : [{ ...p, productId: p.productId }],
		);
		return {
			lines: pending.length,
			problems: await catchUp(tx, found, from),
		};
	});
}

// Catches up lines still without a product that now resolve to one the way a
// new order's lines do (listing, SKU, alias, SKU in other capitals): after an
// alias is added, or a line synced before its product existed. Only one
// channel's lines, or only lines with the given SKUs. Safe to repeat.
export async function applySkusToOrders(
	db: Db,
	only: { channel: Channel } | { skus: string[] },
	from: StockLocations,
): Promise<{ lines: number; problems: string[] }> {
	if ("skus" in only && only.skus.length === 0)
		return { lines: 0, problems: [] };
	return db.transaction(async (tx) => {
		const pending = await tx
			.select(pendingColumns)
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(
				and(
					isNull(orderLines.productId),
					isNotNull(orderLines.sku),
					"skus" in only
						? inArray(orderLines.sku, only.skus)
						: eq(stores.channel, only.channel),
				),
			)
			.for("update", { of: orderLines });
		const found: (Pending & { productId: number })[] = [];
		for (const p of pending) {
			const productId = await resolveProduct(tx, p.store.id, p.line);
			if (productId !== null) found.push({ ...p, productId });
		}
		return {
			lines: found.length,
			problems: await catchUp(tx, found, from),
		};
	});
}

// Takes stock now for in-store sales that couldn't take it when they came
// in, because the retail store didn't exist yet (see scripts/add-retail-store.ts).
// Safe to repeat: a line never takes stock twice.
export async function applyStoreSales(
	db: Db,
): Promise<{ lines: number; problems: string[] }> {
	const from = await stockLocations(db);
	return db.transaction(async (tx) => {
		const pending = await tx
			.select(pendingColumns)
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(
				and(
					eq(orders.soldInStore, true),
					isNotNull(orderLines.productId),
					isNull(orderLines.saleBatchId),
					gt(orderLines.quantity, 0),
				),
			)
			.for("update", { of: orderLines });
		const problems: string[] = [];
		let lines = 0;
		for (const { line, order, store } of pending) {
			if (line.productId === null || !orderTakesStock(store, order)) continue;
			lines++;
			const problem = await takeStock(
				tx,
				{ ...line, productId: line.productId },
				order,
				from,
			);
			if (problem) problems.push(problem);
		}
		return { lines, problems };
	});
}

// Links a SKU a channel sold under to a product for good, as an alias: this
// sale, past ones, and later ones on any channel take that product's stock.
// Listings with that SKU get the product too. Refused when the SKU is already
// a product's own, or linked to another product.
export async function linkSku(db: Db, alias: string, sku: string) {
	const [product] = await db
		.select({
			id: products.id,
			sku: products.sku,
			archivedAt: products.archivedAt,
		})
		.from(products)
		.where(eq(products.sku, sku));
	if (!product) throw new Error(`No product ${sku}`);
	if (product.archivedAt)
		throw new Error(`${product.sku} is archived; restore it first`);
	if (alias === product.sku) throw new Error(`${alias} is that product's SKU`);
	const [own] = await db
		.select({ sku: products.sku })
		.from(products)
		.where(eq(products.sku, alias));
	if (own) throw new Error(`${alias} is already the SKU of its own product`);
	const [linked] = await db
		.select({ sku: products.sku })
		.from(productAliases)
		.innerJoin(products, eq(products.id, productAliases.productId))
		.where(eq(productAliases.alias, alias));
	if (linked && linked.sku !== product.sku)
		throw new Error(`${alias} is already linked to ${linked.sku}`);
	if (!linked)
		await db.insert(productAliases).values({ alias, productId: product.id });
	const from = await stockLocations(db);
	const byListing = await applyListingsToOrders(
		db,
		await autoMapListings(db),
		from,
	);
	const bySku = await applySkusToOrders(db, { skus: [alias] }, from);
	return {
		sku: product.sku,
		ordersUpdated: byListing.lines + bySku.lines,
		problems: [...byListing.problems, ...bySku.problems],
	};
}

// Matches an unmatched item's listings to an existing product by SKU, all
// or none, then catches up the orders that already sold them.
export async function matchListing(db: Db, listingIds: number[], sku: string) {
	const product = await db.transaction(async (tx) => {
		await unmatchedListings(tx, listingIds);
		const [found] = await tx
			.select({ id: products.id, sku: products.sku })
			.from(products)
			.where(eq(products.sku, sku));
		if (!found) throw new Error(`No product ${sku}`);
		for (const id of listingIds) await mapListing(tx, id, found.id);
		return found;
	});
	return catchUpListings(db, listingIds, product.sku);
}

// Creates the product an unmatched item is selling, filled in from its
// listings, and matches them all to it. A listing with no SKU needs one given.
export async function productFromListing(
	db: Db,
	listingIds: number[],
	given: { sku?: string; name?: string } = {},
) {
	const product = await db.transaction(async (tx) => {
		const [lead] = await unmatchedListings(tx, listingIds);
		const sku = given.sku?.trim() || lead.externalSku?.trim();
		if (!sku) throw new Error("This listing has no SKU; give the product one");
		const made = await createProduct(tx, {
			sku,
			name: given.name?.trim() || cleanTitle(lead.title),
		});
		for (const id of listingIds) await mapListing(tx, id, made.id);
		return made;
	});
	return catchUpListings(db, listingIds, product.sku);
}

async function catchUpListings(db: Db, listingIds: number[], sku: string) {
	const caughtUp = await applyListingsToOrders(
		db,
		listingIds,
		await stockLocations(db),
	);
	return { sku, ordersUpdated: caughtUp.lines, problems: caughtUp.problems };
}
