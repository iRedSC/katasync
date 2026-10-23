import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { postMovements, recordSale, undoBatch } from "./ledger";
import { setRecipe } from "./recipes";
import { soldByDay, soldSince } from "./sales";

let db: Db;
let warehouse: number;
let storeId: number;
let orderCount = 0;
const since = new Date("2026-01-01T00:00:00Z");
const placedAt = new Date("2026-10-05T12:00:00Z");

// Records a sale the way order ingest does: the order line keeps its sale
// batch. With recorded false, the line stands for a sale before the ledger.
async function sell(
	productId: number,
	quantity: number,
	options: { recorded?: boolean; fulfilledByChannel?: boolean } = {},
) {
	const n = ++orderCount;
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId: `o${n}`,
			name: `#${n}`,
			placedAt,
			fulfillmentStatus: "FULFILLED",
			fulfilledByChannel: options.fulfilledByChannel ?? false,
			total: 1,
			sourceUpdatedAt: placedAt,
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId: order.id,
			externalId: `l${n}`,
			productId,
			title: "x",
			quantity,
			unitPrice: 1,
		})
		.returning();
	if (options.recorded === false) return null;
	const sale = await recordSale(db, {
		productId,
		quantity,
		locationId: warehouse,
		reference: `order:${order.id}:${line.id}`,
	});
	await db
		.update(schema.orderLines)
		.set({ saleBatchId: sale.batchId })
		.where(eq(schema.orderLines.id, line.id));
	return sale.batchId;
}

async function receive(productId: number, quantity: number) {
	await postMovements(db, {
		lines: [
			{ productId, locationId: warehouse, delta: quantity, reason: "receipt" },
		],
	});
}

async function partsOf(parentProductId: number) {
	return db
		.select({
			productId: schema.productComponents.componentProductId,
			quantity: schema.productComponents.quantity,
		})
		.from(schema.productComponents)
		.where(eq(schema.productComponents.parentProductId, parentProductId));
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values([{ name: "Warehouse", kind: "owned" }])
		.returning();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "amazon", name: "Amazon" })
		.returning();
});

describe("sales history", () => {
	test("a recorded sale keeps the parts it was sold with after the recipe changes", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const bit = await createProduct(db, "BIT", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: wrench, quantity: 2 }]);
		await sell(set, 3);
		await setRecipe(db, set, [{ productId: bit, quantity: 5 }]);

		const sold = await soldSince(db, since, { includeFba: true });
		expect(sold.get(wrench)).toBe(6);
		expect(sold.has(bit)).toBe(false);
		expect(await soldByDay(db, since)).toEqual([
			{ productId: wrench, day: "2026-10-05", units: 6 },
		]);
		expect(await db.select().from(schema.salesUnits)).toEqual([
			expect.objectContaining({ productId: wrench, units: 6 }),
		]);
	});

	test("a sale the ledger never recorded counts the recipe as it stands, beside recorded ones", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const bit = await createProduct(db, "BIT", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: wrench, quantity: 2 }]);
		await sell(set, 1);
		await sell(set, 1, { recorded: false });
		await setRecipe(db, set, [{ productId: bit, quantity: 5 }]);

		const sold = await soldSince(db, since, { includeFba: true });
		expect(sold.get(wrench)).toBe(2);
		expect(sold.get(bit)).toBe(5);
		expect(await db.select().from(schema.salesUnits)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ productId: wrench, units: 2 }),
				expect.objectContaining({ productId: bit, units: 5 }),
			]),
		);
	});

	test("an undone sale is no longer recorded, so it counts once by the recipe", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: wrench, quantity: 2 }]);
		const batchId = await sell(set, 3);
		if (batchId === null) throw new Error("the sale should be recorded");
		await undoBatch(db, batchId);

		const sold = await soldSince(db, since, { includeFba: true });
		expect(sold.get(wrench)).toBe(6);
	});

	test("Amazon's own shipments count only where FBA is included, by the recipe", async () => {
		const bit = await createProduct(db, "BIT", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: bit, quantity: 2 }]);
		await sell(set, 4, { recorded: false, fulfilledByChannel: true });

		expect((await soldSince(db, since, { includeFba: false })).has(bit)).toBe(
			false,
		);
		expect((await soldSince(db, since, { includeFba: true })).get(bit)).toBe(8);
		expect(await soldByDay(db, since)).toEqual([]);
	});
});

describe("setRecipe on a kit with stock", () => {
	let bit: number;
	let bolt: number;
	let kit: number;

	beforeEach(async () => {
		bit = await createProduct(db, "BIT", "simple");
		bolt = await createProduct(db, "BOLT", "simple");
		kit = await createProduct(db, "BIT-KIT", "kit");
		await setRecipe(db, kit, [{ productId: bit, quantity: 1 }]);
	});

	test("its parts can't change while it has stock", async () => {
		await receive(kit, 2);

		await expect(
			setRecipe(db, kit, [{ productId: bolt, quantity: 1 }]),
		).rejects.toThrow(/inventory history/);
		expect(await partsOf(kit)).toEqual([{ productId: bit, quantity: 1 }]);
	});

	test("negative stock blocks a change too", async () => {
		await recordSale(db, {
			productId: kit,
			quantity: 1,
			locationId: warehouse,
			reference: "order:oversold",
		});

		await expect(
			setRecipe(db, kit, [{ productId: bolt, quantity: 1 }]),
		).rejects.toThrow(/inventory history/);
	});

	test("selling out a kit does not allow its historical composition to change", async () => {
		await receive(kit, 2);
		await recordSale(db, {
			productId: kit,
			quantity: 2,
			locationId: warehouse,
			reference: "order:sold-out",
		});

		await expect(
			setRecipe(db, kit, [{ productId: bolt, quantity: 1 }]),
		).rejects.toThrow(/inventory history/);
		expect(await partsOf(kit)).toEqual([{ productId: bit, quantity: 1 }]);
	});

	test("an unused kit can change its parts", async () => {
		await setRecipe(db, kit, [{ productId: bolt, quantity: 1 }]);
		expect(await partsOf(kit)).toEqual([{ productId: bolt, quantity: 1 }]);
	});

	test("saving the same parts is allowed with stock, in any order", async () => {
		const bitKit = await createProduct(db, "TWO-PART-KIT", "kit");
		await setRecipe(db, bitKit, [
			{ productId: bit, quantity: 1 },
			{ productId: bolt, quantity: 3 },
		]);
		await receive(bitKit, 2);
		await receive(kit, 2);

		await setRecipe(db, bitKit, [
			{ productId: bolt, quantity: 3 },
			{ productId: bit, quantity: 1 },
		]);
		await setRecipe(db, kit, [{ productId: bit, quantity: 1 }]);
		expect(await partsOf(bitKit)).toHaveLength(2);
		expect(await partsOf(kit)).toEqual([{ productId: bit, quantity: 1 }]);
	});
});
