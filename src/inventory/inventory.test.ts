import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	getAvailability,
	getBundleBlockers,
	getBundlesContaining,
} from "./availability";
import {
	assembleKits,
	cancelCountRequests,
	disassembleKits,
	postMovements,
	recordCount,
	recordSale,
	requestCounts,
	undoBatch,
} from "./ledger";
import { setRecipe } from "./recipes";

let db: Db;
let warehouse: number;
let garage: number;

function sku(code: string, kind: "simple" | "kit" | "bundle") {
	return createProduct(db, code, kind);
}

async function receive(productId: number, locationId: number, qty: number) {
	await postMovements(db, {
		lines: [{ productId, locationId, delta: qty, reason: "receipt" }],
	});
}

async function onHand(productId: number, locationId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(
			sql`${schema.stockLevels.productId} = ${productId} and ${schema.stockLevels.locationId} = ${locationId}`,
		);
	return row?.onHand ?? 0;
}

beforeEach(async () => {
	db = await createTestDb();
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
				{ productId: wrench, locationId: warehouse, delta: -3, reason: "sale" },
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
					{
						productId: wrench,
						locationId: warehouse,
						delta: 5,
						reason: "receipt",
					},
					{
						productId: 9999,
						locationId: warehouse,
						delta: 5,
						reason: "receipt",
					},
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
			productId: wrench,
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
			{ productId: wrench, quantity: 2 },
			{ productId: socket, quantity: 1 },
		]);
		await receive(wrench, warehouse, 10);
		await receive(socket, warehouse, 10);

		await recordSale(db, {
			productId: set,
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
		await setRecipe(db, kit, [{ productId: bit, quantity: 5 }]);
		await receive(bit, warehouse, 12);

		await assembleKits(db, {
			kitProductId: kit,
			quantity: 2,
			locationId: warehouse,
		});
		expect(await onHand(kit, warehouse)).toBe(2);
		expect(await onHand(bit, warehouse)).toBe(2);

		await disassembleKits(db, {
			kitProductId: kit,
			quantity: 1,
			locationId: warehouse,
		});
		expect(await onHand(kit, warehouse)).toBe(1);
		expect(await onHand(bit, warehouse)).toBe(7);
	});

	test("assembly without enough components changes nothing", async () => {
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		await setRecipe(db, kit, [{ productId: bit, quantity: 5 }]);
		await receive(bit, warehouse, 4);

		await expect(
			assembleKits(db, {
				kitProductId: kit,
				quantity: 1,
				locationId: warehouse,
			}),
		).rejects.toThrow(/Not enough stock.*BIT/);
		expect(await onHand(bit, warehouse)).toBe(4);
		expect(await onHand(kit, warehouse)).toBe(0);
	});

	test("an oversold kit can still be assembled", async () => {
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		await setRecipe(db, kit, [{ productId: bit, quantity: 1 }]);
		await receive(bit, warehouse, 5);
		await recordSale(db, {
			productId: kit,
			quantity: 2,
			locationId: warehouse,
			reference: "order-1",
		});

		await assembleKits(db, {
			kitProductId: kit,
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
		await setRecipe(db, kit, [{ productId: bit, quantity: 1 }]);

		await expect(
			setRecipe(db, otherKit, [{ productId: kit, quantity: 1 }]),
		).rejects.toThrow(/kit can't contain a kit/);
		await expect(
			setRecipe(db, bigSet, [{ productId: set, quantity: 1 }]),
		).rejects.toThrow(/bundle can't contain a bundle/);
		await expect(
			setRecipe(db, bit, [{ productId: kit, quantity: 1 }]),
		).rejects.toThrow(/simple SKU/);
		await setRecipe(db, set, [
			{ productId: kit, quantity: 1 },
			{ productId: bit, quantity: 2 },
		]);
	});
});

describe("getAvailability", () => {
	test("a bundle is limited by its scarcest component across chosen locations", async () => {
		const wrench = await sku("WRENCH", "simple");
		const bit = await sku("BIT", "simple");
		const kit = await sku("BIT-KIT", "kit");
		const set = await sku("SET", "bundle");
		await setRecipe(db, kit, [{ productId: bit, quantity: 1 }]);
		await setRecipe(db, set, [
			{ productId: wrench, quantity: 2 },
			{ productId: kit, quantity: 1 },
		]);
		await receive(wrench, warehouse, 5);
		await receive(wrench, garage, 4);
		await receive(bit, warehouse, 10);
		await assembleKits(db, {
			kitProductId: kit,
			quantity: 6,
			locationId: warehouse,
		});

		const both = await getAvailability(db, [wrench, kit, set], {
			locationIds: [warehouse, garage],
			keep: null,
		});
		expect(both.get(wrench)).toBe(9);
		expect(both.get(kit)).toBe(6);
		expect(both.get(set)).toBe(4); // 9 wrenches / 2

		const warehouseOnly = await getAvailability(db, [set], {
			locationIds: [warehouse],
			keep: null,
		});
		expect(warehouseOnly.get(set)).toBe(2); // 5 wrenches / 2

		expect(await getBundlesContaining(db, wrench)).toEqual([set]);
	});

	test("negative stock counts as zero", async () => {
		const wrench = await sku("WRENCH", "simple");
		await recordSale(db, {
			productId: wrench,
			quantity: 2,
			locationId: warehouse,
			reference: "o",
		});
		expect(
			(
				await getAvailability(db, [wrench], {
					locationIds: [warehouse],
					keep: null,
				})
			).get(wrench),
		).toBe(0);
	});
});

describe("products", () => {
	test("a barcode belongs to one product", async () => {
		await db
			.insert(schema.products)
			.values({ sku: "A", name: "A", kind: "simple", barcode: "012345678905" });
		await expect(
			db.insert(schema.products).values({
				sku: "B",
				name: "B",
				kind: "simple",
				barcode: "012345678905",
			}),
		).rejects.toThrow();
	});

	test("a variant name needs a group", async () => {
		await expect(
			db
				.insert(schema.products)
				.values({ sku: "A", name: "A", kind: "simple", variantName: "Large" }),
		).rejects.toThrow();
		const [group] = await db
			.insert(schema.productGroups)
			.values({ name: "Flat box" })
			.returning();
		await db.insert(schema.products).values({
			sku: "BOX-L",
			name: "Flat box",
			kind: "simple",
			groupId: group.id,
			variantName: "Large",
		});
	});
});

describe("getBundleBlockers", () => {
	test("names the components that leave bundles unsellable", async () => {
		const handle = await sku("HANDLE", "simple");
		const blade = await sku("BLADE", "simple");
		const knife = await sku("KNIFE", "simple");
		const setA = await sku("SET-A", "bundle");
		const setB = await sku("SET-B", "bundle");
		await setRecipe(db, setA, [
			{ productId: handle, quantity: 2 },
			{ productId: blade, quantity: 1 },
		]);
		await setRecipe(db, setB, [
			{ productId: handle, quantity: 1 },
			{ productId: knife, quantity: 1 },
		]);
		await receive(handle, warehouse, 1); // enough for SET-B, not SET-A
		await receive(blade, warehouse, 5);

		expect(
			await getBundleBlockers(db, { locationIds: [warehouse], keep: null }),
		).toEqual([
			{ productId: handle, blocks: [setA] },
			{ productId: knife, blocks: [setB] },
		]);
	});
});

describe("recordCount", () => {
	test("records the difference between the count and what we thought", async () => {
		const wrench = await sku("WRENCH", "simple");
		await recordSale(db, {
			productId: wrench,
			quantity: 3,
			locationId: warehouse,
			reference: "o",
		});

		expect(
			await recordCount(db, {
				productId: wrench,
				locationId: warehouse,
				counted: 4,
				note: "Counted",
			}),
		).toMatchObject({ delta: 7, onHand: 4 });
		expect(await onHand(wrench, warehouse)).toBe(4);
	});

	test("a matching count records nothing", async () => {
		const wrench = await sku("WRENCH", "simple");
		await receive(wrench, warehouse, 5);
		const before = (await db.select().from(schema.movements)).length;
		expect(
			await recordCount(db, {
				productId: wrench,
				locationId: warehouse,
				counted: 5,
				note: "Counted",
			}),
		).toEqual({ delta: 0, onHand: 5, batchId: null });
		expect(await db.select().from(schema.movements)).toHaveLength(before);
	});

	test("logs every count, matched or not, and marks undone ones", async () => {
		const wrench = await sku("WRENCH", "simple");
		await receive(wrench, warehouse, 5);
		const count = (counted: number) =>
			recordCount(db, {
				productId: wrench,
				locationId: warehouse,
				counted,
				note: "Counted",
			});
		await count(5);
		const { batchId } = await count(3);
		if (!batchId) throw new Error("expected a batch");
		await undoBatch(db, batchId);

		const history = await db
			.select()
			.from(schema.countHistory)
			.orderBy(schema.countHistory.id);
		expect(history).toMatchObject([
			{ sku: "WRENCH", expected: 5, counted: 5, drift: 0, undone: false },
			{ sku: "WRENCH", expected: 5, counted: 3, drift: -2, undone: true },
		]);
	});

	test("tool sets can't be counted", async () => {
		const set = await sku("SET", "bundle");
		await expect(
			recordCount(db, {
				productId: set,
				locationId: warehouse,
				counted: 1,
				note: "x",
			}),
		).rejects.toThrow(/count their parts/);
	});
});

describe("count requests", () => {
	async function requested(productId: number, locationId: number) {
		const [row] = await db
			.select({
				at: sql<string | null>`${schema.stockLevels.countRequestedAt}::text`,
			})
			.from(schema.stockLevels)
			.where(
				sql`${schema.stockLevels.productId} = ${productId} and ${schema.stockLevels.locationId} = ${locationId}`,
			);
		return row?.at;
	}

	test("asking again keeps a shelf's place in the queue", async () => {
		const wrench = await sku("WRENCH", "simple");
		const ask = () =>
			requestCounts(db, { productIds: [wrench], locationId: warehouse });
		const [first] = await ask();
		expect(first).toMatchObject({ productId: wrench, locationId: warehouse });
		expect(await ask()).toEqual([]);
		expect(await requested(wrench, warehouse)).toBe(first.requestedAt);
	});

	test("an old undo can't clear a newer request", async () => {
		const wrench = await sku("WRENCH", "simple");
		const ask = () =>
			requestCounts(db, { productIds: [wrench], locationId: warehouse });
		const old = await ask();
		await recordCount(db, {
			productId: wrench,
			locationId: warehouse,
			counted: 2,
			note: "Counted",
		});
		const again = await ask();
		expect(again).toHaveLength(1);
		expect(again[0].requestedAt).not.toBe(old[0].requestedAt);

		expect(await cancelCountRequests(db, old)).toBe(0);
		expect(await requested(wrench, warehouse)).toBe(again[0].requestedAt);
		expect(await cancelCountRequests(db, again)).toBe(1);
		expect(await requested(wrench, warehouse)).toBeNull();
	});

	test("undo leaves the shelf a request created", async () => {
		const wrench = await sku("WRENCH", "simple");
		const asked = await requestCounts(db, {
			productIds: [wrench],
			locationId: garage,
		});
		expect(await cancelCountRequests(db, asked)).toBe(1);
		expect(await requested(wrench, garage)).toBeNull();
	});
});

describe("undoBatch", () => {
	test("reverses a count exactly, once", async () => {
		const wrench = await sku("WRENCH", "simple");
		await receive(wrench, warehouse, 5);
		const { batchId } = await recordCount(db, {
			productId: wrench,
			locationId: warehouse,
			counted: 2,
			note: "Counted",
		});
		if (!batchId) throw new Error("expected a batch");

		await undoBatch(db, batchId);
		expect(await onHand(wrench, warehouse)).toBe(5);
		await expect(undoBatch(db, batchId)).rejects.toThrow(/Already undone/);
	});

	describe("a count's date", () => {
		const lastCountedAt = async (productId: number) => {
			const [row] = await db
				.select({ at: schema.stockLevels.lastCountedAt })
				.from(schema.stockLevels)
				.where(sql`${schema.stockLevels.productId} = ${productId}`);
			return row.at;
		};
		const count = async (productId: number, counted: number) => {
			const { batchId } = await recordCount(db, {
				productId,
				locationId: warehouse,
				counted,
				note: "Counted",
			});
			return batchId;
		};

		test("goes back to never counted when the first count is undone", async () => {
			const wrench = await sku("WRENCH", "simple");
			await receive(wrench, warehouse, 5);
			const batchId = await count(wrench, 2);
			expect(await lastCountedAt(wrench)).toBeInstanceOf(Date);

			if (!batchId) throw new Error("expected a batch");
			await undoBatch(db, batchId);
			expect(await lastCountedAt(wrench)).toBeNull();
		});

		test("goes back to the earlier count when a later one is undone", async () => {
			const wrench = await sku("WRENCH", "simple");
			await receive(wrench, warehouse, 5);
			const first = await count(wrench, 4);
			const firstAt = await lastCountedAt(wrench);
			const second = await count(wrench, 2);
			expect(await lastCountedAt(wrench)).not.toEqual(firstAt);

			if (!first || !second) throw new Error("expected batches");
			await undoBatch(db, second);
			expect(await lastCountedAt(wrench)).toEqual(firstAt);
		});

		test("stays as it is when a later count replaced it", async () => {
			const wrench = await sku("WRENCH", "simple");
			await receive(wrench, warehouse, 5);
			const first = await count(wrench, 2);
			// This one matches, so it posts nothing but still marks the shelf counted.
			await count(wrench, 2);
			const laterAt = await lastCountedAt(wrench);

			if (!first) throw new Error("expected a batch");
			await undoBatch(db, first);
			expect(await onHand(wrench, warehouse)).toBe(5);
			expect(await lastCountedAt(wrench)).toEqual(laterAt);
		});
	});
});
