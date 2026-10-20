import { createServerFn } from "@tanstack/react-start";
import { getDb } from "#/db/client";
import { locations, products, stores } from "#/db/schema";
import { carried } from "#/products/archive";

export const listProductIndex = createServerFn({ method: "GET" }).handler(
	async () =>
		getDb()
			.select({
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
			})
			.from(products)
			.where(carried)
			.orderBy(products.sku),
);

export const listLocations = createServerFn({ method: "GET" }).handler(
	async () => getDb().select().from(locations).orderBy(locations.name),
);

export const listStores = createServerFn({ method: "GET" }).handler(async () =>
	getDb().select().from(stores).orderBy(stores.name),
);
