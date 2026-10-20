import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { desc, isNotNull, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { locations, products, stockLevels } from "#/db/schema";
import { archiveProduct } from "#/products/archive";

// Products no longer carried, latest first, with what's still on our shelves
// (a return can land on one).
export const listArchivedProducts = createServerFn({ method: "GET" }).handler(
	async () =>
		getDb()
			.select({
				id: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				archivedAt: sql<Date>`${products.archivedAt}`,
				onHand: sql<number>`coalesce((select sum(${stockLevels.onHand}) from ${stockLevels} join ${locations} on ${locations.id} = ${stockLevels.locationId} where ${stockLevels.productId} = ${products.id} and ${locations.kind} = 'owned'), 0)::int`,
			})
			.from(products)
			.where(isNotNull(products.archivedAt))
			.orderBy(desc(products.archivedAt), products.name),
);

// Refused, saying what to settle first, while the product is still active
// (src/products/archive.ts).
export const archiveProductNow = createServerFn({ method: "POST" })
	.validator(type({ sku: "string > 0" }))
	.handler(async ({ data }) => archiveProduct(getDb(), data.sku));

export const countArchivedProducts = createServerFn({ method: "GET" }).handler(
	async () => {
		const [row] = await getDb()
			.select({ n: sql<number>`count(*)::int` })
			.from(products)
			.where(isNotNull(products.archivedAt));
		return row?.n ?? 0;
	},
);
