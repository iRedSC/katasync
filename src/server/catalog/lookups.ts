import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { locations, products, stores } from "#/db/schema";
import { setPosLocation } from "#/inventory/locations";
import { carried } from "#/products/archive";
import { isPart } from "#/products/parts";

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
				part: isPart,
			})
			.from(products)
			.where(carried)
			.orderBy(products.sku),
);

export const listLocations = createServerFn({ method: "GET" }).handler(
	async () => getDb().select().from(locations).orderBy(locations.name),
);

// Where Shopify POS sales take stock from, from the next sale on.
export const savePosLocation = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => setPosLocation(getDb(), data.id));

export const listStores = createServerFn({ method: "GET" }).handler(async () =>
	getDb().select().from(stores).orderBy(stores.name),
);
