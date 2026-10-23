import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	catalogs,
	productSuppliers,
	products,
	supplierCatalogs,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";

// Catalogs: the lines products are sold in. A product is in one catalog at
// most, and every supplier carrying that catalog sells it, each on its own
// terms (productSuppliers). Reorder buys each product from the cheapest
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

// Every catalog, by name, with how many products it holds and who carries it.
export async function listCatalogs(db: Db) {
	const [rows, sizes, carriers] = await Promise.all([
		db
			.select({ id: catalogs.id, name: catalogs.name })
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
// bought from no one, so they're moved out first.
export async function deleteCatalog(db: Db, id: number) {
	await db.transaction(async (tx) => {
		const [inside] = await tx
			.select({ n: count() })
			.from(products)
			.where(eq(products.catalogId, id));
		if (inside.n > 0)
			throw new PurchaseOrderError(
				`It still has ${inside.n} ${inside.n === 1 ? "product" : "products"}; move them to another catalog first`,
			);
		await tx.delete(catalogs).where(eq(catalogs.id, id));
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

// The catalogs a supplier carries, by name.
export async function catalogsOf(db: Db, supplierId: number) {
	return db
		.select({ id: catalogs.id, name: catalogs.name })
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
// the product: it has to carry the product's catalog, so terms can't pile up
// where reorder never looks. Returns the terms as they were, with the
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
			carried: sql<boolean>`exists (select 1 from ${supplierCatalogs} where ${supplierCatalogs.supplierId} = ${supplierId} and ${supplierCatalogs.catalogId} = ${products.catalogId})`,
		})
		.from(products)
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
