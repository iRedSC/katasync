import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "#/db/capability-schema";
import { getRecipe } from "#/inventory/ledger/post";
import { setRecipe } from "#/inventory/recipes";
import { lockDatabase } from "#/test/locks";
import { setProductKind } from "./kind";

const url = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !url)
	throw new Error("TEST_POSTGRES_URL is not set, so kind changes go untested");

describe.skipIf(!url)("product kind lock ordering", () => {
	const pg = lockDatabase(url ?? "");
	beforeAll(() => pg.open(), 60000);
	afterAll(() => pg.close());

	test("a kind change locks its parts with it, so a recipe edit waits instead of deadlocking", async () => {
		// The part has the lower id: locking the set first would take it last.
		const [part, set] = await pg.db
			.insert(schema.products)
			.values([
				{ sku: "KIND-PART", name: "Part", kind: "simple" },
				{ sku: "KIND-SET", name: "Set", kind: "simple" },
			])
			.returning();
		await pg.race(
			(text) => text.includes('from "products"') && text.endsWith("for update"),
			(db) =>
				setProductKind(db, set.id, {
					kind: "bundle",
					components: [{ productId: part.id, quantity: 1 }],
				}),
			(db) => setRecipe(db, set.id, [{ productId: part.id, quantity: 2 }]),
		);
		expect(await getRecipe(pg.db, set.id)).toEqual([
			{ productId: part.id, quantity: 2 },
		]);
	}, 20000);
});
