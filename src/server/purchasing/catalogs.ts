import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { catalogDetail, findForCatalog } from "#/purchasing/catalog-detail";
import {
	createCatalog as createCatalogRow,
	deleteCatalog as deleteCatalogRow,
	describeCatalog as describeCatalogRow,
	ensureCatalog,
	listCatalogs as listCatalogRows,
	renameCatalog as renameCatalogRow,
	restoreCatalog as restoreCatalogRow,
	setCarried,
	setCatalogPhoto as setCatalogPhotoRow,
	setProductsCatalog,
} from "#/purchasing/catalogs";

export type { CatalogDetail } from "#/purchasing/catalog-detail";
export type { CatalogRow } from "#/purchasing/catalogs";

// Every catalog, with its size and who carries it.
export const listCatalogs = createServerFn({ method: "GET" }).handler(
	async () => listCatalogRows(getDb()),
);

// A catalog by name, made if there isn't one. Returns its id.
export const makeCatalog = createServerFn({ method: "POST" })
	.validator(type({ name: "string" }))
	.handler(async ({ data }) => ensureCatalog(getDb(), data.name));

// A new catalog, refusing a name already taken. Returns its id.
export const createCatalog = createServerFn({ method: "POST" })
	.validator(type({ name: "string", description: "string | null" }))
	.handler(async ({ data }) => createCatalogRow(getDb(), data));

// One catalog with its carriers and every product's offers.
export const getCatalog = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => catalogDetail(getDb(), data.id));

// Products to add to a catalog, matching SKU or name.
export const findProductsForCatalog = createServerFn({ method: "GET" })
	.validator(type({ query: "string" }))
	.handler(async ({ data }) => findForCatalog(getDb(), data.query));

// Returns the description before, for undo.
export const describeCatalog = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", description: "string | null" }))
	.handler(async ({ data }) =>
		describeCatalogRow(getDb(), data.id, data.description),
	);

// Shows an uploaded photo for a catalog (see /api/catalog-photos), or none.
// Returns the photo before, for undo.
export const setCatalogPhoto = createServerFn({ method: "POST" })
	.validator(
		type({ id: "number.integer > 0", photoId: "number.integer > 0 | null" }),
	)
	.handler(async ({ data }) =>
		setCatalogPhotoRow(getDb(), data.id, data.photoId),
	);

export const renameCatalog = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", name: "string" }))
	.handler(async ({ data }) => renameCatalogRow(getDb(), data.id, data.name));

// Returns what restoreCatalog needs to make it again.
export const deleteCatalog = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => deleteCatalogRow(getDb(), data.id));

// Undo for deleteCatalog. Returns the new id.
export const restoreCatalog = createServerFn({ method: "POST" })
	.validator(
		type({
			name: "string > 0",
			description: "string | null",
			photoId: "number.integer > 0 | null",
			supplierIds: "(number.integer > 0)[]",
		}),
	)
	.handler(async ({ data }) => restoreCatalogRow(getDb(), data));

// Puts products in a catalog, or none. Returns each one's catalog before,
// which undo puts back with setProductCatalogs.
export const setProductCatalog = createServerFn({ method: "POST" })
	.validator(
		type({
			productIds: "(number.integer > 0)[] > 0",
			catalogId: "number.integer > 0 | null",
		}),
	)
	.handler(async ({ data }) =>
		setProductsCatalog(getDb(), data.productIds, data.catalogId),
	);

// Puts each product back in the catalog it had (undo for setProductCatalog).
export const restoreProductCatalogs = createServerFn({ method: "POST" })
	.validator(
		type({
			before: type({
				productId: "number.integer > 0",
				catalogId: "number.integer > 0 | null",
			}).array(),
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const groups = new Map<number | null, number[]>();
		for (const b of data.before)
			groups.set(b.catalogId, [
				...(groups.get(b.catalogId) ?? []),
				b.productId,
			]);
		for (const [catalogId, ids] of groups)
			await setProductsCatalog(db, ids, catalogId);
	});

// Starts or stops a supplier carrying a catalog.
export const setSupplierCarries = createServerFn({ method: "POST" })
	.validator(
		type({
			supplierId: "number.integer > 0",
			catalogId: "number.integer > 0",
			carried: "boolean",
		}),
	)
	.handler(async ({ data }) => setCarried(getDb(), data));
