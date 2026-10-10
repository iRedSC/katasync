import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements, recordCount } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { aItemsAtRisk, safetyDays } from "#/purchasing/reorder";
import { createProduct, createTestDb } from "#/test/db";
import { abcClasses, classify, isCountDue } from "./abc";

const now = new Date("2026-10-10T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("classify", () => {
	const rows = (...values: number[]) =>
		values.map((value, i) => ({ productId: i + 1, value, units: 1 }));
	const classes = (m: ReturnType<typeof classify>) =>
		[...m].sort(([a], [b]) => a - b).map(([, r]) => r.abc);

	test("splits at 80% and 95% of value, the crossing product going higher", () => {
		// Running totals before each: 0, 70, 85, 94, 97, 99 of 100.
		expect(classes(classify(rows(70, 15, 9, 3, 2, 1)))).toEqual([
			"A",
			"A",
			"B",
			"B",
			"C",
			"C",
		]);
	});

	test("ranks by value with ties broken by id", () => {
		const m = classify(rows(5, 10, 10));
		expect([1, 2, 3].map((id) => m.get(id)?.rank)).toEqual([3, 1, 2]);
		expect(m.get(2)?.share).toBeCloseTo(0.4);
	});

	test("unsold products are C, and nothing sold means all C", () => {
		expect(classes(classify(rows(100, 0)))).toEqual(["A", "C"]);
		expect(classes(classify(rows(0, 0)))).toEqual(["C", "C"]);
	});
});

describe("isCountDue", () => {
	test("A monthly, B quarterly, C and unclassed yearly, never counted now", () => {
		expect(isCountDue("A", daysAgo(29), now)).toBe(false);
		expect(isCountDue("A", daysAgo(30), now)).toBe(true);
		expect(isCountDue("B", daysAgo(89), now)).toBe(false);
		expect(isCountDue("B", daysAgo(90), now)).toBe(true);
		expect(isCountDue("C", daysAgo(364), now)).toBe(false);
		expect(isCountDue(null, daysAgo(365), now)).toBe(true);
		expect(isCountDue("C", null, now)).toBe(true);
	});
});

test("safety stock goes to A items only", () => {
	expect(safetyDays("A", 15)).toBe(8);
	expect(safetyDays("B", 15)).toBe(0);
	expect(safetyDays(null, 15)).toBe(0);
});

describe("with a database", () => {
	let db: Db;
	let warehouse: number;
	let store: number;
	let orderCount = 0;

	async function sell(
		productId: number,
		quantity: number,
		extra: Partial<typeof schema.orders.$inferInsert> = {},
	) {
		const n = ++orderCount;
		const [order] = await db
			.insert(schema.orders)
			.values({
				storeId: store,
				externalId: `o${n}`,
				name: `#${n}`,
				placedAt: daysAgo(10),
				fulfillmentStatus: "FULFILLED",
				total: 1,
				sourceUpdatedAt: now,
				...extra,
			})
			.returning();
		await db.insert(schema.orderLines).values({
			orderId: order.id,
			externalId: `l${n}`,
			productId,
			title: "x",
			quantity,
			unitPrice: 1,
		});
	}

	async function product(sku: string, unitCost: number | null) {
		const id = await createProduct(db, sku, "simple");
		if (unitCost !== null) {
			await db
				.update(schema.products)
				.set({ unitCost })
				.where(eq(schema.products.id, id));
		}
		return id;
	}

	beforeEach(async () => {
		db = await createTestDb();
		[{ id: warehouse }] = await db
			.insert(schema.locations)
			.values({ name: "Warehouse", kind: "owned" })
			.returning();
		[{ id: store }] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: "Amazon" })
			.returning();
	});

	test("values tool sets through their parts, counts FBA, skips cancelled", async () => {
		const blade = await product("BLADE", 10);
		const handle = await product("HANDLE", 1);
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [{ productId: blade, quantity: 2 }]);

		await sell(set, 5); // 10 blades
		await sell(blade, 5, { fulfilledByChannel: true });
		await sell(blade, 100, { cancelledAt: now });
		await sell(blade, 1, { placedAt: daysAgo(400) });
		await sell(handle, 3);

		const { classes, days } = await abcClasses(db, now);
		expect(classes.get(blade)).toMatchObject({ abc: "A", units: 15 });
		expect(classes.get(blade)?.value).toBe(150);
		expect(classes.get(handle)?.abc).toBe("C");
		expect(classes.has(set)).toBe(false);
		expect(days).toBe(365);
	});

	test("leaves out sold products with no cost, and reports short history", async () => {
		const priced = await product("PRICED", 2);
		const unpriced = await product("UNPRICED", null);
		const idle = await product("IDLE", null);
		await sell(priced, 1, { placedAt: daysAgo(40) });
		await sell(unpriced, 1);

		const { classes, unpriced: count, days } = await abcClasses(db, now);
		expect(classes.has(unpriced)).toBe(false);
		expect(count).toBe(1);
		expect(classes.get(idle)?.abc).toBe("C");
		expect(days).toBe(40);
	});

	test("a count that matches still marks the shelf counted", async () => {
		const p = await product("P", 1);
		await postMovements(db, {
			lines: [
				{
					productId: p,
					locationId: warehouse,
					delta: 4,
					reason: "opening_balance",
				},
			],
		});
		const result = await recordCount(db, {
			productId: p,
			locationId: warehouse,
			counted: 4,
			note: "Counted",
		});
		expect(result.delta).toBe(0);
		const [level] = await db.select().from(schema.stockLevels);
		expect(level.lastCountedAt).toBeInstanceOf(Date);
	});

	test("flags A items that run out before a new PO could arrive", async () => {
		const fast = await product("FAST", 10);
		const slow = await product("SLOW", 1);
		// 90 sold over 90 days: 1 a day against the default 14 day lead time.
		await sell(fast, 90, { fulfilledByChannel: false });
		await sell(slow, 1);
		await postMovements(db, {
			lines: [
				{
					productId: fast,
					locationId: warehouse,
					delta: 5,
					reason: "opening_balance",
				},
			],
		});
		expect(await aItemsAtRisk(db, now)).toMatchObject([
			{ sku: "FAST", daysLeft: 5, leadTimeDays: 14 },
		]);

		await postMovements(db, {
			lines: [
				{
					productId: fast,
					locationId: warehouse,
					delta: 10,
					reason: "opening_balance",
				},
			],
		});
		expect(await aItemsAtRisk(db, now)).toEqual([]);
	});
});
