import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { updateProductDetails } from "./details";

test("a cost put back keeps the day it was set, never a day ahead", async () => {
	const db = await createTestDb();
	const id = await createProduct(db, "BLADE", "simple");
	const setAt = async () =>
		(
			await db
				.select({ at: schema.products.unitCostUpdatedAt })
				.from(schema.products)
				.where(eq(schema.products.id, id))
		)[0].at;

	const before = new Date("2026-03-04T12:00:00Z");
	await updateProductDetails(db, id, { unitCost: 4, unitCostSetAt: before });
	expect(await setAt()).toEqual(before);

	await updateProductDetails(db, id, { unitCost: 5 });
	expect((await setAt())?.getTime()).toBeGreaterThan(before.getTime());

	const ahead = new Date(Date.now() + 86_400_000);
	await updateProductDetails(db, id, { unitCost: 4, unitCostSetAt: ahead });
	expect((await setAt())?.getTime()).toBeLessThan(ahead.getTime());
});
