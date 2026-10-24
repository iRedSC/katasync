import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { isPart } from "./parts";

test("parts are what Shopify files as parts, or named by part number", async () => {
	const db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const box = await createProduct(db, "BOX", "simple");
	const wiper = await createProduct(db, "WIPER", "simple");
	const arm = await createProduct(db, "ARM", "simple");
	await db
		.update(schema.products)
		.set({ name: "[05-42S] Creaser Arm" })
		.where(eq(schema.products.id, arm));
	await db.insert(schema.listings).values([
		{
			storeId: store.id,
			externalId: "v1",
			title: "Box",
			productId: box,
			productType: "Flat Box",
		},
		{
			storeId: store.id,
			externalId: "v2",
			title: "Wiper",
			productId: wiper,
			productType: "Flat Box Part",
		},
	]);
	const rows = await db
		.select({ sku: schema.products.sku, part: isPart })
		.from(schema.products)
		.orderBy(schema.products.sku);
	expect(rows).toEqual([
		{ sku: "ARM", part: true },
		{ sku: "BOX", part: false },
		{ sku: "WIPER", part: true },
	]);
});
