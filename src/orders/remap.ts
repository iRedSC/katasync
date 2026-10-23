import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { mapListings } from "#/channels/listing-claims";
import {
	autoMapListings,
	cleanTitle,
	createProductNamed as createProduct,
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
import { costOf, resolveProduct } from "./ingest";
import { reconcileStock, type StockScope } from "./reconcile-stock";

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

// Gives each line its product and cost. Stock is taken by reconcileStock, so a
// line whose stock fails is still picked up by the next catch-up or sync.
async function catchUp(tx: Db, found: (Pending & { productId: number })[]) {
	for (const { line, productId } of found)
		await tx
			.update(orderLines)
			.set({ productId, unitCost: await costOf(tx, productId) })
			.where(eq(orderLines.id, line.id));
}

// After listings get a product, catch up the orders that already sold them,
// then take their stock. Safe to repeat.
export async function applyListingsToOrders(
	db: Db,
	listingIds: number[],
	from: StockLocations,
): Promise<{ lines: number; problems: string[] }> {
	if (listingIds.length === 0) return { lines: 0, problems: [] };
	const lines = await db.transaction(async (tx) => {
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
		await catchUp(tx, found);
		return pending.length;
	});
	const settled = await reconcileStock(db, from);
	return { lines, problems: settled.problems };
}

// Lines per transaction when catching up. Each batch locks only its own lines
// and commits before the next, so a long backlog never holds one long lock,
// and a run that stops part way resumes where it stopped.
const CATCH_UP_BATCH = 200;

// What a line's listing and SKU resolve to, asked once per call: a SKU that
// stays unknown isn't looked up again in every batch it's in.
async function resolveOnce(
	tx: Db,
	resolved: Map<string, number | null>,
	storeId: number,
	line: Pending["line"],
) {
	const key = JSON.stringify([storeId, line.listingExternalId, line.sku]);
	if (!resolved.has(key))
		resolved.set(key, await resolveProduct(tx, storeId, line));
	return resolved.get(key) ?? null;
}

// Catches up lines still without a product that now resolve to one the way a
// new order's lines do (listing, SKU, alias, SKU in other capitals): after an
// alias is added, or a line synced before its product existed. Only one
// channel's lines, or only lines with the given SKUs, then takes the stock of
// their unsettled lines. Safe to repeat.
export async function applySkusToOrders(
	db: Db,
	only: StockScope,
	from: StockLocations,
): Promise<{ lines: number; problems: string[] }> {
	if ("skus" in only && only.skus.length === 0)
		return { lines: 0, problems: [] };
	const resolved = new Map<string, number | null>();
	let lines = 0;
	let after = 0;
	for (;;) {
		const batch = await db.transaction(async (tx) => {
			const pending = await tx
				.select(pendingColumns)
				.from(orderLines)
				.innerJoin(orders, eq(orders.id, orderLines.orderId))
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.where(
					and(
						gt(orderLines.id, after),
						isNull(orderLines.productId),
						isNotNull(orderLines.sku),
						"skus" in only
							? inArray(orderLines.sku, only.skus)
							: eq(stores.channel, only.channel),
					),
				)
				.orderBy(asc(orderLines.id))
				.limit(CATCH_UP_BATCH)
				.for("update", { of: orderLines });
			const found: (Pending & { productId: number })[] = [];
			for (const p of pending) {
				const productId = await resolveOnce(tx, resolved, p.store.id, p.line);
				if (productId !== null) found.push({ ...p, productId });
			}
			await catchUp(tx, found);
			return {
				scanned: pending.length,
				lastId: pending.at(-1)?.line.id ?? after,
				lines: found.length,
			};
		});
		lines += batch.lines;
		if (batch.scanned < CATCH_UP_BATCH) break;
		after = batch.lastId;
	}
	const settled = await reconcileStock(db, from, only);
	return { lines, problems: settled.problems };
}

// Takes stock now for every line still owed it, after a retail store or POS
// location is set up. Safe to repeat: a line never takes stock twice.
export async function applyStoreSales(
	db: Db,
): Promise<{ lines: number; problems: string[] }> {
	return reconcileStock(db, await stockLocations(db));
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
		const locked = await unmatchedListings(tx, listingIds);
		const [found] = await tx
			.select({ id: products.id, sku: products.sku })
			.from(products)
			.where(eq(products.sku, sku));
		if (!found) throw new Error(`No product ${sku}`);
		await mapListings(tx, locked, found.id);
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
		const locked = await unmatchedListings(tx, listingIds);
		const [lead] = locked;
		const sku = given.sku?.trim() || lead.externalSku?.trim();
		if (!sku) throw new Error("This listing has no SKU; give the product one");
		const made = await createProduct(tx, {
			sku,
			name: given.name?.trim() || cleanTitle(lead.title),
		});
		await mapListings(tx, locked, made.id);
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
