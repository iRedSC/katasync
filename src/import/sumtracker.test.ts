import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { getAvailability } from "#/inventory/availability";
import { createTestDb } from "#/test/db";
import { applySumtrackerImport, planSumtrackerImport } from "./sumtracker";

const productsHeader =
	"id,name,sku,variant_name,uom,barcode,tax,categories,product_type,notes,inventory_sync_enabled,bundle_type,created,is_archived,wavg_landed_cost,price,currency_price,image_url";

function product(
	sku: string,
	extra: Partial<
		Record<"name" | "variant" | "barcode" | "type" | "bundle" | "cost", string>
	> = {},
) {
	return [
		"1",
		extra.name ?? sku,
		sku,
		extra.variant ?? "",
		"",
		extra.barcode ?? "",
		"",
		"",
		extra.type ?? "",
		"",
		"True",
		extra.bundle ?? "NONE",
		"2026-01-01 00-00",
		"False",
		extra.cost ?? "0.0000",
		"",
		"",
		"",
	].join(",");
}

const stockHeader =
	"id,name,variant_name,sku,primary_supplier,warehouse,in_stock,booked,available,incoming,min_level,max_level,close_at_quantity,price,wavg_landed_cost,total_cost,barcode,notes,updated";

function stock(sku: string, qty: number, warehouse = "WAREHOUSE") {
	return `1,${sku},,${sku},,${warehouse},${qty},0,${qty},0,,,,,0,0,,,2026-01-01 00-00`;
}

const fixture = {
	products: [
		productsHeader,
		product("BOX-S", {
			name: "Flat Box",
			variant: "Small",
			barcode: "'012345",
			type: "Flat Box",
			cost: "50.5000",
		}),
		product("BOX-L", { name: "Flat Box", variant: "Large", barcode: "999" }),
		product("BLADE", { barcode: "999" }),
		product("SET", { bundle: "BUNDLE" }),
		product("BOX-S-AMZ"),
		product("BLADE-AMZ", { bundle: "BUNDLE" }),
	].join("\n"),
	bundles: [
		"sku,component_sku,quantity",
		"SET,BOX-S,1",
		"SET,BLADE,2",
		"BLADE-AMZ,BLADE,1",
	].join("\n"),
	stock: [
		stockHeader,
		stock("BOX-S", 3),
		stock("BOX-L", 0),
		stock("BLADE", -2),
		stock("BOX-S-AMZ", 0),
	].join("\n"),
};

describe("planSumtrackerImport", () => {
	test("maps Sumtracker's shapes onto products, groups, and aliases", () => {
		const plan = planSumtrackerImport(fixture);
		expect(plan.products.map((p) => p.sku)).toEqual([
			"BOX-S",
			"BOX-L",
			"BLADE",
			"SET",
		]);
		expect(plan.groups).toEqual([{ name: "Flat Box", imageUrl: null }]);
		expect(plan.aliases).toEqual([
			{ alias: "BOX-S-AMZ", sku: "BOX-S" },
			{ alias: "BLADE-AMZ", sku: "BLADE" },
		]);

		const boxS = plan.products[0];
		expect(boxS).toMatchObject({
			groupName: "Flat Box",
			variantName: "Small",
			barcode: "012345",
			category: "Flat Box",
			unitCost: 50.5,
		});
		expect(plan.products[2]).toMatchObject({
			barcode: null,
			unitCost: null,
			groupName: null,
		});

		expect(plan.recipes.get("SET")).toEqual([
			{ sku: "BOX-S", quantity: 1 },
			{ sku: "BLADE", quantity: 2 },
		]);
		expect(plan.openingStock).toEqual([
			{ sku: "BOX-S", quantity: 3 },
			{ sku: "BLADE", quantity: -2 },
		]);
		expect(plan.warnings).toEqual([
			"Barcode 999 is shared by BOX-L, BLADE; left blank on all",
		]);
	});

	test("fails on anything it can't place, listing every problem", () => {
		expect(() =>
			planSumtrackerImport({
				...fixture,
				bundles: `${fixture.bundles}\nBLADE,BOX-S,1\nBLADE-AMZ,BOX-S,1`,
				stock: `${fixture.stock}\n${stock("BOX-L", 1, "GARAGE")}`,
			}),
		).toThrow(
			/BLADE is not an imported bundle[\s\S]*BLADE-AMZ contains more[\s\S]*unexpected warehouse "GARAGE"/,
		);
	});

	test("reports the line of a malformed row", () => {
		expect(() =>
			planSumtrackerImport({
				...fixture,
				bundles: "sku,component_sku,quantity\nSET,BLADE,two",
			}),
		).toThrow(/bundles.csv line 2/);
	});
});

describe("applySumtrackerImport", () => {
	let db: Db;
	beforeEach(async () => {
		db = await createTestDb();
	});

	test("writes the catalog and opening stock", async () => {
		const result = await applySumtrackerImport(
			db,
			planSumtrackerImport(fixture),
			"Warehouse",
		);
		expect(result).toEqual({
			products: 4,
			groups: 1,
			bundles: 1,
			aliases: 2,
			stockLines: 2,
		});

		const ids = new Map(
			(await db.select().from(schema.products)).map((p) => [p.sku, p.id]),
		);
		const [warehouse] = await db.select().from(schema.locations);
		const available = await getAvailability(
			db,
			[...ids.values()],
			[warehouse.id],
		);
		expect(available.get(ids.get("BOX-S") ?? 0)).toBe(3);
		expect(available.get(ids.get("SET") ?? 0)).toBe(0); // BLADE is oversold

		const movements = await db.select().from(schema.movements);
		expect(movements.every((m) => m.reason === "opening_balance")).toBe(true);
	});

	test("refuses to import twice", async () => {
		const plan = planSumtrackerImport(fixture);
		await applySumtrackerImport(db, plan, "Warehouse");
		await expect(applySumtrackerImport(db, plan, "Warehouse")).rejects.toThrow(
			/empty catalog/,
		);
	});
});
