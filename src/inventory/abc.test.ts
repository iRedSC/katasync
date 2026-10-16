import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements, recordCount } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { aItemsAtRisk, safetyDays } from "#/purchasing/reorder";
import { createProduct, createTestDb } from "#/test/db";
import { abcClasses, classify } from "./abc";

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

	test("ranks tool sets among themselves by their own sales", async () => {
		const blade = await product("BLADE", 10);
		const pump = await product("PUMP", 300);
		const big = await createProduct(db, "BIG", "bundle");
		const small = await createProduct(db, "SMALL", "bundle");
		const unpricedSet = await createProduct(db, "NOCOST", "bundle");
		const noCost = await product("NOCOST-PART", null);
		await setRecipe(db, big, [
			{ productId: pump, quantity: 1 },
			{ productId: blade, quantity: 2 },
		]);
		await setRecipe(db, small, [{ productId: blade, quantity: 1 }]);
		await setRecipe(db, unpricedSet, [{ productId: noCost, quantity: 1 }]);

		await sell(big, 2); // 2 x 320 = 640
		await sell(small, 20); // 20 x 10 = 200
		await sell(unpricedSet, 1);

		const { sets, classes, unpriced } = await abcClasses(db, now);
		expect(sets.get(big)).toMatchObject({ abc: "A", rank: 1, value: 640 });
		expect(sets.get(small)).toMatchObject({ rank: 2, units: 20 });
		expect(sets.has(unpricedSet)).toBe(false);
		expect(classes.has(big)).toBe(false);
		// The set with a cost-less part, and that part sold through it.
		expect(unpriced).toBe(2);
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

	describe("units on order", () => {
		// 1 a day, 5 on hand: the shelf is empty in 5 days.
		async function fastWithSentPo(
			dates: { expectedAt: Date | null; sentAt?: Date },
			lead = 14,
		) {
			const fast = await product("FAST", 10);
			await sell(fast, 90, { fulfilledByChannel: false });
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
			const [supplier] = await db
				.insert(schema.suppliers)
				.values({ name: "Acme", code: "ACME", leadTimeDays: lead })
				.returning();
			const [po] = await db
				.insert(schema.purchaseOrders)
				.values({
					supplierId: supplier.id,
					locationId: warehouse,
					status: "sent",
					sentAt: dates.sentAt ?? daysAgo(1),
					expectedAt: dates.expectedAt,
				})
				.returning();
			await db.insert(schema.purchaseOrderLines).values({
				purchaseOrderId: po.id,
				productId: fast,
				quantity: 100,
			});
		}
		const daysAhead = (n: number) => daysAgo(-n);

		test("ignores a PO that arrives after the shelf runs out", async () => {
			await fastWithSentPo({ expectedAt: daysAhead(14) });
			expect(await aItemsAtRisk(db, now)).toMatchObject([
				{ sku: "FAST", daysLeft: 5 },
			]);
		});

		test("counts a PO that arrives in time", async () => {
			await fastWithSentPo({ expectedAt: daysAhead(3) });
			expect(await aItemsAtRisk(db, now)).toEqual([]);
		});

		test("ignores a PO that is already overdue", async () => {
			await fastWithSentPo({ expectedAt: daysAgo(2) });
			expect(await aItemsAtRisk(db, now)).toMatchObject([
				{ sku: "FAST", daysLeft: 5 },
			]);
		});

		test("dates a PO with no expected date from the supplier's lead time", async () => {
			// Sent a day ago with 3 days of lead time: lands in 2 days.
			await fastWithSentPo({ expectedAt: null }, 3);
			expect(await aItemsAtRisk(db, now)).toEqual([]);
		});
	});
});
