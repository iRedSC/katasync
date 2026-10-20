import { createServerFn } from "@tanstack/react-start";
import { getDb } from "#/db/client";
import { locations, products, stores } from "#/db/schema";

export const listProductIndex = createServerFn({ method: "GET" }).handler(
	async () =>
		getDb()
			.select({
				id: products.id,
				sku: products.sku,
				name: products.name,
				kind: products.kind,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
			})
			.from(products)
			.orderBy(products.sku),
);

export const listLocations = createServerFn({ method: "GET" }).handler(
	async () => getDb().select().from(locations).orderBy(locations.name),
);

export const listStores = createServerFn({ method: "GET" }).handler(async () =>
	getDb().select().from(stores).orderBy(stores.name),
);
