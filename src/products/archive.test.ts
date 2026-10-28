import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import {
	activate,
	channelOrder,
	quantityWorld,
} from "#/inventory/commitments.fixtures";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import { archiveProduct } from "./archive";

let db: Db;
let world: Awaited<ReturnType<typeof quantityWorld>>;

beforeEach(async () => {
	db = await createTestDb();
	world = await quantityWorld(db);
	await activate(db);
});

describe("archiving", () => {
	test("a product promised to open orders stays, even with none on hand", async () => {
		await createProduct(db, "WRENCH", "simple");
		await world.ingest(channelOrder());

		await expect(archiveProduct(db, "WRENCH")).rejects.toThrow(
			"3 promised to open orders",
		);
	});

	test("a part a tool set promised before its parts changed stays too", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const blade = await createProduct(db, "BLADE", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: wrench, quantity: 2 }]);
		const order = channelOrder();
		await world.ingest({
			...order,
			lines: [{ ...order.lines[0], sku: "SET", quantity: 1 }],
		});
		await setRecipe(db, set, [{ productId: blade, quantity: 1 }]);

		await expect(archiveProduct(db, "WRENCH")).rejects.toThrow(
			"2 promised to open orders",
		);
		await setRecipe(db, set, [{ productId: wrench, quantity: 2 }]);
		await archiveProduct(db, "BLADE");
	});
});
