import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { applyCostImport, costCatalog, planCostImport } from "./costs";

const list = (...rows: string[]) => ["sku,name,cost", ...rows].join("\n");

describe("planCostImport", () => {
	const catalog = [
		{ id: 1, sku: "ROLLER", kind: "simple" as const, unitCost: 200 },
		{ id: 2, sku: "Knife", kind: "simple" as const, unitCost: null },
		{ id: 3, sku: "SET", kind: "bundle" as const, unitCost: 5 },
		{ id: 4, sku: "OLD", kind: "simple" as const, unitCost: 9 },
		{ id: 5, sku: "PLAIN", kind: "simple" as const, unitCost: null },
		{ id: 6, sku: "PAN", kind: "simple" as const, unitCost: 3 },
	];
	const aliases = [
		{ alias: "KNIFE-AMZ", productId: 2 },
		{ alias: "PAN-AMZ", productId: 6 },
	];

	test("costs by SKU in any capitals, an alias filling in", () => {
		const plan = planCostImport(
			list(
				"roller,Roller,180.5",
				"ROLLER,,",
				"KNIFE-AMZ,Knife,12",
				"SET,Set,40",
				"PAN,Pan,3",
				"PAN-AMZ,Pan,4",
				"GONE,Gone,7",
				"NOCOST,No cost,",
			),
			catalog,
			aliases,
		);
		expect(plan.set).toEqual([
			{ productId: 1, sku: "ROLLER", from: 200, to: 180.5 },
			{ productId: 2, sku: "Knife", from: null, to: 12 },
			{ productId: 6, sku: "PAN", from: 3, to: 3 },
		]);
		// Not costed by the list: a tool set's own cost goes, the rest stay.
		expect(plan.clear).toEqual([
			{ productId: 3, sku: "SET", from: 5, bundle: true },
			{ productId: 4, sku: "OLD", from: 9, bundle: false },
		]);
		expect(plan.unknown).toEqual(["GONE"]);
		expect(plan.warnings).toEqual([
			"PAN costs 3 but its alias PAN-AMZ costs 4; kept 3",
		]);
	});

	test("two costs for one SKU leave it without one", () => {
		const plan = planCostImport(
			list("ROLLER,,10", "roller,,11"),
			catalog,
			aliases,
		);
		expect(plan.set).toEqual([]);
		expect(plan.clear.map((c) => c.sku)).toContain("ROLLER");
		expect(plan.warnings).toEqual([
			"ROLLER has costs 10 and 11; left without one",
		]);
	});

	test("refuses a cost that isn't a number", () => {
		expect(() => planCostImport(list("ROLLER,,ten"), catalog, [])).toThrow(
			'ROLLER costs "ten"',
		);
	});
});

describe("applyCostImport", () => {
	test("sets and dates costs, keeps the rest, and leaves sales' costs alone", async () => {
		const db = await createTestDb();
		const blade = await createProduct(db, "BLADE", "simple");
		const handle = await createProduct(db, "HANDLE", "simple");
		const kit = await createProduct(db, "KIT", "bundle");
		await db.insert(schema.productComponents).values([
			{ parentProductId: kit, componentProductId: blade, quantity: 2 },
			{ parentProductId: kit, componentProductId: handle, quantity: 1 },
		]);
		await db
			.update(schema.products)
			.set({ unitCost: 99 })
			.where(eq(schema.products.id, handle));
		const [store] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: "Amazon" })
			.returning();
		const [order] = await db
			.insert(schema.orders)
			.values({
				storeId: store.id,
				externalId: "o1",
				name: "#1",
				placedAt: new Date("2026-01-01"),
				fulfillmentStatus: "FULFILLED",
				total: 150,
				sourceUpdatedAt: new Date("2026-01-01"),
			})
			.returning();
		const line = (externalId: string, productId: number, unitCost: number) => ({
			orderId: order.id,
			externalId,
			productId,
			title: "x",
			quantity: 1,
			unitPrice: 50,
			unitCost,
		});
		await db
			.insert(schema.orderLines)
			.values([
				line("b", blade, 1),
				line("h", handle, 99),
				line("k", kit, 101),
				{ ...line("u", blade, 0), unitCost: null },
			]);

		const { catalog, aliases } = await costCatalog(db);
		const plan = planCostImport(list("BLADE,,4.25"), catalog, aliases);
		expect(await applyCostImport(db, plan)).toEqual({
			costed: 1,
			cleared: 0,
			kept: 1,
			salesCosted: 1,
		});

		const costs = await db
			.select({
				sku: schema.products.sku,
				unitCost: schema.products.unitCost,
				dated: schema.products.unitCostUpdatedAt,
			})
			.from(schema.products)
			.orderBy(schema.products.sku);
		expect(costs).toEqual([
			{ sku: "BLADE", unitCost: 4.25, dated: expect.any(Date) },
			{ sku: "HANDLE", unitCost: 99, dated: expect.any(Date) },
			{ sku: "KIT", unitCost: null, dated: null },
		]);
		const lines = await db
			.select({
				id: schema.orderLines.externalId,
				unitCost: schema.orderLines.unitCost,
			})
			.from(schema.orderLines)
			.orderBy(schema.orderLines.externalId);
		// Each sale keeps what it took; the one that went out with no cost
		// takes the first one.
		expect(lines).toEqual([
			{ id: "b", unitCost: 1 },
			{ id: "h", unitCost: 99 },
			{ id: "k", unitCost: 101 },
			{ id: "u", unitCost: 4.25 },
		]);
	});
});

describe("cost date", () => {
	test("set when the cost changes, kept when it doesn't, cleared with it", async () => {
		const db = await createTestDb();
		const id = await createProduct(db, "BLADE", "simple");
		const dated = async () =>
			(
				await db
					.select({ at: schema.products.unitCostUpdatedAt })
					.from(schema.products)
					.where(eq(schema.products.id, id))
			)[0].at;
		const set = (values: Partial<typeof schema.products.$inferInsert>) =>
			db.update(schema.products).set(values).where(eq(schema.products.id, id));

		expect(await dated()).toBeNull();
		await set({ unitCost: 5 });
		const first = await dated();
		expect(first).toBeInstanceOf(Date);

		const old = new Date("2025-01-01");
		await set({ unitCostUpdatedAt: old });
		await set({ unitCost: 5, name: "Blade" });
		expect(await dated()).toEqual(old);

		await set({ unitCost: 6 });
		expect((await dated())?.getTime()).toBeGreaterThan(old.getTime());

		await set({ unitCost: null, unitCostUpdatedAt: new Date() });
		expect(await dated()).toBeNull();
	});
});
