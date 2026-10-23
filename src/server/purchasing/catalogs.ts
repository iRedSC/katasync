import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	deleteCatalog as deleteCatalogRow,
	ensureCatalog,
	listCatalogs as listCatalogRows,
	renameCatalog as renameCatalogRow,
	setCarried,
	setProductsCatalog,
} from "#/purchasing/catalogs";

export type { CatalogRow } from "#/purchasing/catalogs";

// Every catalog, with its size and who carries it.
export const listCatalogs = createServerFn({ method: "GET" }).handler(
	async () => listCatalogRows(getDb()),
);

// A catalog by name, made if there isn't one. Returns its id.
export const makeCatalog = createServerFn({ method: "POST" })
	.validator(type({ name: "string" }))
	.handler(async ({ data }) => ensureCatalog(getDb(), data.name));

export const renameCatalog = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", name: "string" }))
	.handler(async ({ data }) => renameCatalogRow(getDb(), data.id, data.name));

export const deleteCatalog = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => deleteCatalogRow(getDb(), data.id));

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
