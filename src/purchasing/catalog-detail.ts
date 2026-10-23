import { and, asc, eq, gte, ilike, or, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	catalogs,
	ownedStock,
	products,
	salesUnits,
	supplierCatalogs,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";

// How far back a catalog's page counts sales.
const SOLD_DAYS = 90;

// One catalog as its page shows it: what it is, who carries it, and each
// product in it with every carrier's terms side by side, so prices compare
// across a row.
export async function catalogDetail(db: Db, id: number) {
	const [catalog] = await db
		.select({
			id: catalogs.id,
			name: catalogs.name,
			description: catalogs.description,
			photoId: catalogs.photoId,
			createdAt: catalogs.createdAt,
		})
		.from(catalogs)
		.where(eq(catalogs.id, id));
	if (!catalog) throw new PurchaseOrderError("No such catalog");

	const since = new Date(Date.now() - SOLD_DAYS * 86_400_000);
	const sold = db
		.select({
			productId: salesUnits.productId,
			units: sql<number>`sum(${salesUnits.units})::int`.as("units"),
		})
		.from(salesUnits)
		.where(gte(salesUnits.placedAt, since))
		.groupBy(salesUnits.productId)
		.as("sold");
	const [carriers, rows, offers] = await Promise.all([
		db
			.select({
				id: suppliers.id,
				name: suppliers.name,
				leadTimeDays: suppliers.leadTimeDays,
			})
			.from(supplierCatalogs)
			.innerJoin(suppliers, eq(suppliers.id, supplierCatalogs.supplierId))
			.where(eq(supplierCatalogs.catalogId, id))
			.orderBy(asc(suppliers.name)),
		db
			.select({
				id: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				kind: products.kind,
				unitCost: products.unitCost,
				archived: sql<boolean>`${products.archivedAt} is not null`,
				onHand: ownedStock.onHand,
				sold: sql<number>`coalesce(${sold.units}, 0)`,
			})
			.from(products)
			.leftJoin(ownedStock, eq(ownedStock.productId, products.id))
			.leftJoin(sold, eq(sold.productId, products.id))
			.where(eq(products.catalogId, id))
			.orderBy(asc(products.name), asc(products.variantName)),
		db
			.select({
				productId: supplierOffers.productId,
				supplierId: supplierOffers.supplierId,
				supplierSku: supplierOffers.supplierSku,
				cost: supplierOffers.cost,
				itemCost: supplierOffers.itemCost,
				unit: supplierOffers.unit,
				packSize: supplierOffers.packSize,
				cheapest: supplierOffers.cheapest,
			})
			.from(supplierOffers)
			.where(eq(supplierOffers.catalogId, id)),
	]);
	const byProduct = new Map<number, typeof offers>();
	for (const o of offers)
		byProduct.set(o.productId, [...(byProduct.get(o.productId) ?? []), o]);
	return {
		catalog,
		soldDays: SOLD_DAYS,
		carriers,
		products: rows.map((p) => ({
			...p,
			// Tool sets have no shelf of their own.
			onHand: p.kind === "bundle" ? null : (p.onHand ?? 0),
			offers: byProduct.get(p.id) ?? [],
		})),
	};
}

export type CatalogDetail = Awaited<ReturnType<typeof catalogDetail>>;

// Products whose SKU or name has the text, with the catalog each is in now,
// so adding one says where it moves from.
export async function findForCatalog(db: Db, query: string) {
	const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 6);
	if (words.length === 0) return [];
	return db
		.select({
			id: products.id,
			sku: products.sku,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			catalogId: products.catalogId,
			catalogName: catalogs.name,
		})
		.from(products)
		.leftJoin(catalogs, eq(catalogs.id, products.catalogId))
		.where(
			and(
				sql`${products.archivedAt} is null`,
				...words.map((w) => {
					const like = `%${w.replace(/[\\%_]/g, "\\$&")}%`;
					return or(
						ilike(products.sku, like),
						ilike(products.name, like),
						ilike(products.variantName, like),
					);
				}),
			),
		)
		.orderBy(asc(products.name), asc(products.variantName))
		.limit(25);
}
