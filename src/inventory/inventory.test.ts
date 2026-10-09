import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { getAvailability, getBundlesContaining } from "./availability";
import {
	assembleKits,
	disassembleKits,
	postMovements,
	recordSale,
} from "./ledger";
import { setRecipe } from "./recipes";

let db: Db;
let warehouse: number;
let garage: number;

async function sku(code: string, kind: "simple" | "kit" | "bundle") {
	const [row] = await db
		.insert(schema.skus)
		.values({ sku: code, name: code, kind })
		.returning();
	return row.id;
}

async function receive(skuId: number, locationId: number, qty: number) {
	await postMovements(db, {
		lines: [{ skuId, locationId, delta: qty, reason: "receipt" }],
	});
}

async function onHand(skuId: number, locationId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(
			sql`${schema.stockLevels.skuId} = ${skuId} and ${schema.stockLevels.locationId} = ${locationId}`,
		);
	return row?.onHand ?? 0;
}

beforeEach(async () => {
	db = drizzle(new PGlite(), { schema, casing: "snake_case" });
	await migrate(db as Parameters<typeof migrate>[0], {
		migrationsFolder: "drizzle",
	});
	[{ id: warehouse }, { id: garage }] = await db
		.insert(schema.locations)
		.values([
			{ name: "Warehouse", kind: "owned" },
			{ name: "Garage", kind: "owned" },
		])
		.returning();
});

describe("postMovements", () => {
	test("keeps stock levels equal to the sum of movements", async () => {
		const wrench = await sku("WRENCH", "simple");
		await receive(wrench, warehouse, 10);
		await postMovements(db, {
			lines: [
				{ skuId: wrench, locationId: warehouse, delta: -3, reason: "sale" },
			],
		});

		const [{ total }] = await db
			.select({ total: sql<number>`sum(${schema.movements.delta})::int` })
			.from(schema.movements);
		expect(total).toBe(7);
		expect(await onHand(wrench, warehouse)).toBe(7);
	});

	test("rolls back every line when one fails", async () => {
		const wrench = await sku("WRENCH", "simple");
		await expect(
			postMovements(db, {
				lines: [
					{ skuId: wrench, locationId: warehouse, delta: 5, reason: "receipt" },
					{ skuId: 9999, locationId: warehouse, delta: 5, reason: "receipt" },
				],
			}),
		).rejects.toThrow();
		expect(await onHand(wrench, warehouse)).toBe(0);
		expect(await db.select().from(schema.movements)).toHaveLength(0);
	});

	test("rejects stock movements on a bundle", async () => {
		const set = await sku("SET", "bundle");
		await expect(receive(set, warehouse, 1)).rejects.toThrow(
			/Bundles have no stock/,
		);
	});

	test("movements can't be edited or deleted", async () => {
		const wrench = await sku("WRENCH", "simple");
		await receive(wrench, warehouse, 1);
		// Drizzle wraps the Postgres error; the trigger's message is the cause.
		const appendOnly = {
			cause: expect.objectContaining({
				message: expect.stringMatching(/append-only/),
			}),
		};
		await expect(
			db.update(schema.movements).set({ delta: 100 }),
		).rejects.toMatchObject(appendOnly);
		await expect(db.delete(schema.movements)).rejects.toMatchObject(appendOnly);
	});
});

describe("recordSale", () => {
	test("allows overselling, because the channel already sold it", async () => {
		const wrench = await sku("WRENCH", "simple");
		await receive(wrench, warehouse, 1);
		await recordSale(db, {
			skuId: wrench,
			quantity: 3,
			locationId: warehouse,
			reference: "order-1",
		});
		expect(await onHand(wrench, warehouse)).toBe(-2);
	});

	test("a bundle sale takes stock from its components", async () => {
		const wrench = await sku("WRENCH", "simple");
		const socket = await sku("SOCKET", "simple");
		const set = await sku("SET", "bundle");
		await setRecipe(db, set, [
			{ skuId: wrench, quantity: 2 },
			{ skuId: socket, quantity: 1 },
		]);
		await receive(wrench, warehouse, 10);
		await receive(socket, warehouse, 10);

		await recordSale(db, {
			skuId: set,
			quantity: 3,
			locationId: warehouse,
			reference: "order-1",
		});
		expect(await onHand(wrench, warehouse)).toBe(4);
		expect(await onHand(socket, warehouse)).toBe(7);
	});
});

describe("kits", () => {
	test("assembly turns components into kits", async () => {
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		await setRecipe(db, kit, [{ skuId: bit, quantity: 5 }]);
		await receive(bit, warehouse, 12);

		await assembleKits(db, {
			kitSkuId: kit,
			quantity: 2,
			locationId: warehouse,
		});
		expect(await onHand(kit, warehouse)).toBe(2);
		expect(await onHand(bit, warehouse)).toBe(2);

		await disassembleKits(db, {
			kitSkuId: kit,
			quantity: 1,
			locationId: warehouse,
		});
		expect(await onHand(kit, warehouse)).toBe(1);
		expect(await onHand(bit, warehouse)).toBe(7);
	});

	test("assembly without enough components changes nothing", async () => {
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		await setRecipe(db, kit, [{ skuId: bit, quantity: 5 }]);
		await receive(bit, warehouse, 4);

		await expect(
			assembleKits(db, { kitSkuId: kit, quantity: 1, locationId: warehouse }),
		).rejects.toThrow(/Not enough stock.*BIT/);
		expect(await onHand(bit, warehouse)).toBe(4);
		expect(await onHand(kit, warehouse)).toBe(0);
	});

	test("an oversold kit can still be assembled", async () => {
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		await setRecipe(db, kit, [{ skuId: bit, quantity: 1 }]);
		await receive(bit, warehouse, 5);
		await recordSale(db, {
			skuId: kit,
			quantity: 2,
			locationId: warehouse,
			reference: "order-1",
		});

		await assembleKits(db, {
			kitSkuId: kit,
			quantity: 1,
			locationId: warehouse,
		});
		expect(await onHand(kit, warehouse)).toBe(-1);
	});
});

describe("setRecipe", () => {
	test("kits hold only simple SKUs and nothing holds a bundle", async () => {
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		const otherKit = await sku("OTHER-KIT", "kit");
		const set = await sku("SET", "bundle");
		const bigSet = await sku("BIG-SET", "bundle");
		await setRecipe(db, kit, [{ skuId: bit, quantity: 1 }]);

		await expect(
			setRecipe(db, otherKit, [{ skuId: kit, quantity: 1 }]),
		).rejects.toThrow(/kit can't contain a kit/);
		await expect(
			setRecipe(db, bigSet, [{ skuId: set, quantity: 1 }]),
		).rejects.toThrow(/bundle can't contain a bundle/);
		await expect(
			setRecipe(db, bit, [{ skuId: kit, quantity: 1 }]),
		).rejects.toThrow(/simple SKU/);
		await setRecipe(db, set, [
			{ skuId: kit, quantity: 1 },
			{ skuId: bit, quantity: 2 },
		]);
	});
});

describe("getAvailability", () => {
	test("a bundle is limited by its scarcest component across chosen locations", async () => {
		const wrench = await sku("WRENCH", "simple");
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		const set = await sku("SET", "bundle");
		await setRecipe(db, kit, [{ skuId: bit, quantity: 1 }]);
		await setRecipe(db, set, [
			{ skuId: wrench, quantity: 2 },
			{ skuId: kit, quantity: 1 },
		]);
		await receive(wrench, warehouse, 5);
		await receive(wrench, garage, 4);
		await receive(bit, warehouse, 10);
		await assembleKits(db, {
			kitSkuId: kit,
			quantity: 6,
			locationId: warehouse,
		});

		const both = await getAvailability(
			db,
			[wrench, kit, set],
			[warehouse, garage],
		);
		expect(both.get(wrench)).toBe(9);
		expect(both.get(kit)).toBe(6);
		expect(both.get(set)).toBe(4); // 9 wrenches / 2

		const warehouseOnly = await getAvailability(db, [set], [warehouse]);
		expect(warehouseOnly.get(set)).toBe(2); // 5 wrenches / 2

		expect(await getBundlesContaining(db, wrench)).toEqual([set]);
	});

	test("negative stock counts as zero", async () => {
		const wrench = await sku("WRENCH", "simple");
		await recordSale(db, {
			skuId: wrench,
			quantity: 2,
			locationId: warehouse,
			reference: "o",
		});
		expect((await getAvailability(db, [wrench], [warehouse])).get(wrench)).toBe(
			0,
		);
	});
});
