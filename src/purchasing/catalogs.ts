import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	catalogPhotos,
	catalogs,
	productSuppliers,
	products,
	supplierCatalogs,
	supplierOffers,
	suppliers,
	supplierUnavailable,
} from "#/db/schema";
import { imageType } from "#/purchasing/damage";
import { PurchaseOrderError } from "#/purchasing/orders";

// Catalogs: the lines products are sold in. A product is in one catalog at
// most, and every supplier carrying that catalog sells it, each on its own
// terms (productSuppliers), unless it has marked the product unavailable
// (supplierUnavailable). Reorder buys each product from the cheapest
// (supplierOffers).

// Each product's cheapest offer, as a subquery to join a second time beside
// another supplier's offer. Views can't be aliased, so it's a subquery.
export function cheapestOffers(db: Db) {
	return db
		.select({
			productId: supplierOffers.productId,
			supplierId: supplierOffers.supplierId,
			itemCost: supplierOffers.itemCost,
		})
		.from(supplierOffers)
		.where(eq(supplierOffers.cheapest, true))
		.as("cheapest_offer");
}

// Every catalog, by name, with what it's about, how many products it holds,
// and who carries it.
export async function listCatalogs(db: Db) {
	const [rows, sizes, carriers] = await Promise.all([
		db
			.select({
				id: catalogs.id,
				name: catalogs.name,
				description: catalogs.description,
				photoId: catalogs.photoId,
			})
			.from(catalogs)
			.orderBy(asc(catalogs.name)),
		db
			.select({ catalogId: products.catalogId, products: count() })
			.from(products)
			.where(sql`${products.catalogId} is not null`)
			.groupBy(products.catalogId),
		db
			.select({
				catalogId: supplierCatalogs.catalogId,
				supplierId: suppliers.id,
				name: suppliers.name,
			})
			.from(supplierCatalogs)
			.innerJoin(suppliers, eq(suppliers.id, supplierCatalogs.supplierId))
			.orderBy(asc(suppliers.name)),
	]);
	return rows.map((c) => ({
		...c,
		products: sizes.find((s) => s.catalogId === c.id)?.products ?? 0,
		suppliers: carriers
			.filter((s) => s.catalogId === c.id)
			.map(({ supplierId, name }) => ({ id: supplierId, name })),
	}));
}

export type CatalogRow = Awaited<ReturnType<typeof listCatalogs>>[number];

function catalogName(raw: string) {
	const name = raw.trim().replace(/\s+/g, " ");
	if (name === "") throw new PurchaseOrderError("A catalog needs a name");
	return name;
}

// A catalog by name, ignoring case, made if there isn't one. Returns its id.
export async function ensureCatalog(db: Db, raw: string) {
	const name = catalogName(raw);
	const [found] = await db
		.select({ id: catalogs.id })
		.from(catalogs)
		.where(sql`lower(${catalogs.name}) = lower(${name})`);
	if (found) return found.id;
	const [made] = await db
		.insert(catalogs)
		.values({ name })
		.onConflictDoNothing()
		.returning({ id: catalogs.id });
	if (made) return made.id;
	// Made meanwhile under exactly this name.
	const [again] = await db
		.select({ id: catalogs.id })
		.from(catalogs)
		.where(eq(catalogs.name, name));
	return again.id;
}

// A new catalog. Unlike ensureCatalog, a name already taken is refused:
// someone making one on purpose means a new one.
export async function createCatalog(
	db: Db,
	input: { name: string; description: string | null },
) {
	const name = catalogName(input.name);
	const taken = new PurchaseOrderError(`There's already a catalog "${name}"`);
	const [clash] = await db
		.select({ id: catalogs.id })
		.from(catalogs)
		.where(sql`lower(${catalogs.name}) = lower(${name})`);
	if (clash) throw taken;
	const [made] = await db
		.insert(catalogs)
		.values({ name, description: description(input.description) })
		.onConflictDoNothing()
		.returning({ id: catalogs.id });
	if (!made) throw taken;
	return made.id;
}

const description = (raw: string | null) => raw?.trim() || null;

// Says what's in a catalog, which its search matches too. Returns the
// description before, for undo.
export async function describeCatalog(db: Db, id: number, raw: string | null) {
	return db.transaction(async (tx) => {
		const [was] = await tx
			.select({ description: catalogs.description })
			.from(catalogs)
			.where(eq(catalogs.id, id))
			.for("update");
		if (!was) throw new PurchaseOrderError("No such catalog");
		await tx
			.update(catalogs)
			.set({ description: description(raw) })
			.where(eq(catalogs.id, id));
		return was.description;
	});
}

// Most a catalog photo may be once shrunk in the browser.
export const MAX_CATALOG_PHOTO_BYTES = 2_000_000;

// Keeps an uploaded photo for a catalog to show. Returns its id.
export async function addCatalogPhoto(db: Db, bytes: Uint8Array) {
	const contentType = imageType(bytes);
	if (!contentType)
		throw new PurchaseOrderError("Photos must be JPEG, PNG, or WebP");
	if (bytes.length > MAX_CATALOG_PHOTO_BYTES)
		throw new PurchaseOrderError("That photo is too big; try a smaller one");
	const [made] = await db
		.insert(catalogPhotos)
		.values({ contentType, data: Buffer.from(bytes) })
		.returning({ id: catalogPhotos.id });
	return made.id;
}

export async function catalogPhoto(db: Db, id: number) {
	const [photo] = await db
		.select({
			contentType: catalogPhotos.contentType,
			data: catalogPhotos.data,
		})
		.from(catalogPhotos)
		.where(eq(catalogPhotos.id, id));
	return photo ?? null;
}

// Shows a photo for a catalog, or none with null. Returns the one before,
// which is kept, so undo puts it back.
export async function setCatalogPhoto(
	db: Db,
	id: number,
	photoId: number | null,
) {
	return db.transaction(async (tx) => {
		const [was] = await tx
			.select({ photoId: catalogs.photoId })
			.from(catalogs)
			.where(eq(catalogs.id, id))
			.for("update");
		if (!was) throw new PurchaseOrderError("No such catalog");
		await tx.update(catalogs).set({ photoId }).where(eq(catalogs.id, id));
		return was.photoId;
	});
}

export async function renameCatalog(db: Db, id: number, raw: string) {
	const name = catalogName(raw);
	const [clash] = await db
		.select({ id: catalogs.id })
		.from(catalogs)
		.where(
			and(
				sql`lower(${catalogs.name}) = lower(${name})`,
				sql`${catalogs.id} <> ${id}`,
			),
		);
	if (clash)
		throw new PurchaseOrderError(`There's already a catalog "${name}"`);
	const done = await db
		.update(catalogs)
		.set({ name })
		.where(eq(catalogs.id, id))
		.returning({ id: catalogs.id });
	if (done.length === 0) throw new PurchaseOrderError("No such catalog");
}

// Removes a catalog nothing is in. One with products would leave them
// bought from no one, so they're moved out first. Returns what undo needs
// to make it again: its details and who carried it.
export async function deleteCatalog(db: Db, id: number) {
	return db.transaction(async (tx) => {
		const [inside] = await tx
			.select({ n: count() })
			.from(products)
			.where(eq(products.catalogId, id));
		if (inside.n > 0)
			throw new PurchaseOrderError(
				`It still has ${inside.n} ${inside.n === 1 ? "product" : "products"}; move them to another catalog first`,
			);
		const carriers = await tx
			.select({ id: supplierCatalogs.supplierId })
			.from(supplierCatalogs)
			.where(eq(supplierCatalogs.catalogId, id));
		const [gone] = await tx
			.delete(catalogs)
			.where(eq(catalogs.id, id))
			.returning({
				name: catalogs.name,
				description: catalogs.description,
				photoId: catalogs.photoId,
			});
		if (!gone) throw new PurchaseOrderError("No such catalog");
		return { ...gone, supplierIds: carriers.map((c) => c.id) };
	});
}

// Makes a deleted catalog again (undo for deleteCatalog), carried by the
// suppliers that carried it. Returns its new id.
export async function restoreCatalog(
	db: Db,
	input: {
		name: string;
		description: string | null;
		photoId: number | null;
		supplierIds: number[];
	},
) {
	return db.transaction(async (tx) => {
		const [made] = await tx
			.insert(catalogs)
			.values({
				name: input.name,
				description: input.description,
				photoId: input.photoId,
			})
			.onConflictDoNothing()
			.returning({ id: catalogs.id });
		if (!made)
			throw new PurchaseOrderError(
				`There's a catalog "${input.name}" again already`,
			);
		if (input.supplierIds.length > 0)
			await tx
				.insert(supplierCatalogs)
				.values(
					input.supplierIds.map((supplierId) => ({
						supplierId,
						catalogId: made.id,
					})),
				)
				.onConflictDoNothing();
		return made.id;
	});
}

// Puts products in a catalog, or in none with null. Tool sets can be in one
// to keep a line together, though they're bought as their parts. Each
// supplier's terms for a product are kept whatever its catalog, so moving it
// back brings them back. Returns each product's catalog before, for undo.
export async function setProductsCatalog(
	db: Db,
	productIds: number[],
	catalogId: number | null,
) {
	if (productIds.length === 0) return [];
	return db.transaction(async (tx) => {
		const before = await tx
			.select({ productId: products.id, catalogId: products.catalogId })
			.from(products)
			.where(inArray(products.id, productIds))
			.for("update");
		if (before.length !== new Set(productIds).size)
			throw new PurchaseOrderError("Some of those products don't exist");
		if (catalogId !== null) {
			const [c] = await tx
				.select({ id: catalogs.id })
				.from(catalogs)
				.where(eq(catalogs.id, catalogId));
			if (!c) throw new PurchaseOrderError("No such catalog");
		}
		await tx
			.update(products)
			.set({ catalogId })
			.where(inArray(products.id, productIds));
		return before;
	});
}

// Starts or stops a supplier carrying a catalog. Its terms for the
// catalog's products are kept either way, so carrying it again restores
// them. Says whether anything changed.
export async function setCarried(
	db: Db,
	input: { supplierId: number; catalogId: number; carried: boolean },
) {
	const { supplierId, catalogId } = input;
	if (input.carried) {
		const made = await db
			.insert(supplierCatalogs)
			.values({ supplierId, catalogId })
			.onConflictDoNothing()
			.returning({ supplierId: supplierCatalogs.supplierId });
		return made.length > 0;
	}
	const gone = await db
		.delete(supplierCatalogs)
		.where(
			and(
				eq(supplierCatalogs.supplierId, supplierId),
				eq(supplierCatalogs.catalogId, catalogId),
			),
		)
		.returning({ supplierId: supplierCatalogs.supplierId });
	return gone.length > 0;
}

// Marks products unavailable from a supplier, or available again, so
// reorder buys them elsewhere meanwhile. Marking one needs the supplier to
// carry its catalog, since otherwise it doesn't sell it anyway; tool sets
// are refused, being bought as their parts. Returns the products that
// changed, for undo.
export async function setUnavailable(
	db: Db,
	input: { supplierId: number; productIds: number[]; unavailable: boolean },
) {
	const { supplierId } = input;
	const productIds = [...new Set(input.productIds)];
	if (productIds.length === 0) return [];
	return db.transaction(async (tx) => {
		const [s] = await tx
			.select({ name: suppliers.name })
			.from(suppliers)
			.where(eq(suppliers.id, supplierId));
		if (!s) throw new PurchaseOrderError("No such supplier");
		const found = await tx
			.select({
				id: products.id,
				sku: products.sku,
				kind: products.kind,
				// Joined, not a subquery: a one-table select leaves column
				// names unqualified, so the subquery would compare its own.
				carried: sql<boolean>`${supplierCatalogs.supplierId} is not null`,
			})
			.from(products)
			.leftJoin(
				supplierCatalogs,
				and(
					eq(supplierCatalogs.catalogId, products.catalogId),
					eq(supplierCatalogs.supplierId, supplierId),
				),
			)
			.where(inArray(products.id, productIds));
		if (found.length !== productIds.length)
			throw new PurchaseOrderError("Some of those products don't exist");
		if (!input.unavailable) {
			const gone = await tx
				.delete(supplierUnavailable)
				.where(
					and(
						eq(supplierUnavailable.supplierId, supplierId),
						inArray(supplierUnavailable.productId, productIds),
					),
				)
				.returning({ productId: supplierUnavailable.productId });
			return gone.map((g) => g.productId);
		}
		const set = found.find((p) => p.kind === "bundle");
		if (set)
			throw new PurchaseOrderError(
				`${set.sku} is a tool set, bought as its parts; mark those instead`,
			);
		const elsewhere = found.find((p) => !p.carried);
		if (elsewhere)
			throw new PurchaseOrderError(
				`${s.name} doesn't carry ${elsewhere.sku}'s catalog, so it doesn't sell it anyway`,
			);
		const made = await tx
			.insert(supplierUnavailable)
			.values(productIds.map((productId) => ({ supplierId, productId })))
			.onConflictDoNothing()
			.returning({ productId: supplierUnavailable.productId });
		return made.map((m) => m.productId);
	});
}

// The catalogs a supplier carries, by name.
export async function catalogsOf(db: Db, supplierId: number) {
	return db
		.select({
			id: catalogs.id,
			name: catalogs.name,
			description: catalogs.description,
			photoId: catalogs.photoId,
		})
		.from(supplierCatalogs)
		.innerJoin(catalogs, eq(catalogs.id, supplierCatalogs.catalogId))
		.where(eq(supplierCatalogs.supplierId, supplierId))
		.orderBy(asc(catalogs.name));
}

type Terms = Partial<
	Omit<typeof productSuppliers.$inferInsert, "productId" | "supplierId">
>;

// Changes a supplier's terms for one product, making its row if it has none
// (EACH, which counts one either way). Refuses a supplier that doesn't sell
// the product: it has to carry the product's catalog and not have marked the
// product unavailable, so terms can't pile up where reorder never looks. Returns the terms as they were, with the
// defaults when there was no row. Lock-free callers race only with each
// other's writes to the same row, which the upsert settles.
export async function setOfferTerms(
	db: Db,
	productId: number,
	supplierId: number,
	set: Terms,
) {
	const [product] = await db
		.select({
			kind: products.kind,
			catalogId: products.catalogId,
			// Joined, not subqueries: a one-table select leaves column names
			// unqualified, so a subquery would compare its own.
			carried: sql<boolean>`${supplierCatalogs.supplierId} is not null`,
			unavailable: sql<boolean>`${supplierUnavailable.supplierId} is not null`,
		})
		.from(products)
		.leftJoin(
			supplierCatalogs,
			and(
				eq(supplierCatalogs.catalogId, products.catalogId),
				eq(supplierCatalogs.supplierId, supplierId),
			),
		)
		.leftJoin(
			supplierUnavailable,
			and(
				eq(supplierUnavailable.productId, products.id),
				eq(supplierUnavailable.supplierId, supplierId),
			),
		)
		.where(eq(products.id, productId));
	if (!product) throw new PurchaseOrderError("That product doesn't exist");
	if (product.kind === "bundle")
		throw new PurchaseOrderError(
			"Tool sets are bought as their parts; set suppliers on those",
		);
	if (product.catalogId === null)
		throw new PurchaseOrderError(
			"Put it in a catalog first: suppliers sell whole catalogs",
		);
	if (!product.carried) {
		const [s] = await db
			.select({ name: suppliers.name })
			.from(suppliers)
			.where(eq(suppliers.id, supplierId));
		if (!s) throw new PurchaseOrderError("No such supplier");
		throw new PurchaseOrderError(
			`${s.name} doesn't carry its catalog; add the catalog to ${s.name} first`,
		);
	}
	if (product.unavailable)
		throw new PurchaseOrderError(
			"That supplier has it marked unavailable; add it back to them first",
		);
	const [was] = await db
		.select()
		.from(productSuppliers)
		.where(
			and(
				eq(productSuppliers.productId, productId),
				eq(productSuppliers.supplierId, supplierId),
			),
		)
		.for("update");
	if (Object.keys(set).length > 0)
		await db
			.insert(productSuppliers)
			.values({ productId, supplierId, supplierCount: 1, ...set })
			.onConflictDoUpdate({
				target: [productSuppliers.productId, productSuppliers.supplierId],
				set,
			});
	return (
		was ?? {
			productId,
			supplierId,
			supplierSku: null,
			unit: "EACH",
			packSize: 1,
			supplierCount: 1,
			cost: null,
			minimumQuantity: 1,
		}
	);
}
