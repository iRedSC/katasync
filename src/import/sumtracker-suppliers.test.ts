import { describe, expect, test } from "vitest";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import {
	applySupplierImport,
	minimumFromNotes,
	planSupplierImport,
} from "./sumtracker-suppliers";

const suppliersHeader =
	"id,code,currency,company_name,first_name,last_name,payment_terms,notes,po_notes,email,phone,address_line_1,address_line_2,city,state,country,pincode,lead_time,safety_days";
const linksHeader =
	"product_id,name,variant_name,sku,currency,supplier_code,is_primary,supplier_sku,uom,pack_size,cost_basis,cost,shipping_cost,moq,notes";

const files = {
	suppliers: [
		suppliersHeader,
		"1,CANAM,USD,CanAm Tools,Linda,Adimora,N30,Free Shipping Min - $1500,,sales@canamtool.com,555,1 Main St,,Erie,PA,US,16501,21,",
		"2,MMC,USD,,,,,,,,,,,,,,,,",
	].join("\n"),
	links: [
		linksHeader,
		"1,Roller,,ROLLER,USD,CANAM,True,J1100,Per Unit,1,Per Unit,222.7000,0.0000,6,",
		"2,Knife,,'05-158,USD,MMC,True,,,1,Per Unit,0.0000,0.0000,1,",
		"3,Set,,SET,USD,MMC,True,,,1,Per Unit,10.0000,0.0000,1,",
		"4,Gone,,GONE,USD,MMC,True,,,1,Per Unit,1.0000,0.0000,1,",
		"5,Sponge,,SPONGE,USD,MMC,True,,,1,Per Unit,140.2500,0.0000,1,",
		// $2 a blade, $24 a case of 12: a per-case price that is right.
		"6,Blade,,BLADE,USD,MMC,True,,Case,12,Per Unit,24.0000,0.0000,2,",
		"7,Tape,,TAPE,USD,MMC,True,,Case,twelve,Per Unit,5.0000,0.0000,1,",
		// A unit katasync doesn't have yet.
		"8,Gloves,,GLOVES,USD,MMC,True,,bag  of 50,50,Per Unit,10.0000,0.0000,1,",
	].join("\n"),
};

const catalog = new Map([
	["ROLLER", { kind: "simple", unitCost: 200 }],
	["05-158", { kind: "simple", unitCost: null }],
	["SET", { kind: "bundle", unitCost: null }],
	["SPONGE", { kind: "simple", unitCost: 2 }],
	["BLADE", { kind: "simple", unitCost: 2 }],
	["TAPE", { kind: "simple", unitCost: 5 }],
	["GLOVES", { kind: "simple", unitCost: 0.2 }],
] as const);

describe("planSupplierImport", () => {
	test("maps suppliers and their products, skipping what can't be bought", () => {
		const plan = planSupplierImport(files, catalog);
		expect(plan.suppliers[0]).toMatchObject({
			code: "CANAM",
			name: "CanAm Tools",
			contactName: "Linda Adimora",
			email: "sales@canamtool.com",
			leadTimeDays: 21,
			minimumOrder: 1500,
		});
		// No company name falls back to the code; defaults stay in the database.
		expect(plan.suppliers[1]).toMatchObject({ code: "MMC", name: "MMC" });
		expect(plan.suppliers[1]).not.toHaveProperty("leadTimeDays");
		expect(plan.links).toEqual([
			{
				sku: "ROLLER",
				supplierCode: "CANAM",
				supplierSku: "J1100",
				// "Per Unit" is Sumtracker for EACH.
				unit: "EACH",
				packSize: 1,
				cost: 222.7,
				minimumQuantity: 6,
			},
			// The spreadsheet's leading ' is stripped; a zero cost means unknown.
			{
				sku: "05-158",
				supplierCode: "MMC",
				supplierSku: null,
				unit: "EACH",
				packSize: 1,
				cost: null,
				minimumQuantity: 1,
			},
			// A case price filed under EACH, so it's left for the product's own cost.
			{
				sku: "SPONGE",
				supplierCode: "MMC",
				supplierSku: null,
				unit: "EACH",
				packSize: 1,
				cost: null,
				minimumQuantity: 1,
			},
			// $24 is right for 12 blades at $2, and the minimum counts cases.
			{
				sku: "BLADE",
				supplierCode: "MMC",
				supplierSku: null,
				unit: "CASE",
				packSize: 12,
				cost: 24,
				minimumQuantity: 2,
			},
			// A pack size that isn't a number falls back to EACH, and the price for
			// that pack goes with it.
			{
				sku: "TAPE",
				supplierCode: "MMC",
				supplierSku: null,
				unit: "EACH",
				packSize: 1,
				cost: null,
				minimumQuantity: 1,
			},
			{
				sku: "GLOVES",
				supplierCode: "MMC",
				supplierSku: null,
				unit: "BAG OF 50",
				packSize: 50,
				cost: 10,
				minimumQuantity: 1,
			},
		]);
		expect(plan.warnings).toEqual([
			'CANAM: minimum order set to $1500 from its notes ("Free Shipping Min - $1500")',
			"No email for MMC; their POs can't be sent until one is added",
			'TAPE: pack size "twelve" isn\'t a whole number from 1 to 2147483647; bought in EACH instead',
			"TAPE: ignored the supplier price $5, which was for a pack that couldn't be read",
			"Skipped 1 links to SKUs katasync doesn't have: GONE",
			"Skipped 1 links to tool sets, which are bought as their parts: SET",
			"Ignored 1 supplier prices over twice or under half the product's cost, probably case prices: SPONGE ($140.25 vs $2)",
			"Units used, added if katasync doesn't have them yet: CASE, BAG OF 50",
		]);
	});

	test("reads units and pack sizes, and warns about what it can't", () => {
		const link = (uom: string, pack: string, cost: string) =>
			planSupplierImport(
				{
					...files,
					links: `${linksHeader}\n1,Roller,,ROLLER,USD,CANAM,True,,${uom},${pack},Per Unit,${cost},0,3,`,
				},
				catalog,
			);
		const first = (uom: string, pack: string, cost = "200") => {
			const plan = link(uom, pack, cost);
			return { ...plan.links[0], warnings: plan.warnings.slice(2) };
		};
		const each = { unit: "EACH", packSize: 1, warnings: [] };
		expect(first("", "")).toMatchObject(each);
		expect(first(" each ", "1")).toMatchObject(each);
		expect(first("PCS", "0")).toMatchObject(each);
		// Case-insensitive, spaces collapsed, like unit names everywhere else.
		expect(first("bag  of 50", "50", "10000")).toMatchObject({
			unit: "BAG OF 50",
			packSize: 50,
			cost: 10000,
			minimumQuantity: 3,
		});
		// EACH can't hold a pack, so it becomes PACK.
		expect(first("Each", "6", "1200")).toMatchObject({
			unit: "PACK",
			packSize: 6,
			warnings: [
				"ROLLER: Each with a pack size of 6; bought in PACK of 6",
				"Units used, added if katasync doesn't have them yet: PACK",
			],
		});
		// A unit with no pack size can't be priced, so it's EACH without the price.
		expect(first("Case", "")).toMatchObject({
			...each,
			cost: null,
			warnings: [
				'ROLLER: pack size "" isn\'t a whole number from 1 to 2147483647; bought in EACH instead',
				"ROLLER: ignored the supplier price $200, which was for a pack that couldn't be read",
			],
		});
		expect(first("Case", "2.5").warnings).toHaveLength(2);
		// A pack the database can't hold fails the whole import at apply time.
		expect(first("Case", "2147483647")).toMatchObject({
			unit: "CASE",
			packSize: 2147483647,
		});
		expect(first("Case", "2147483648")).toMatchObject({
			...each,
			cost: null,
			warnings: [
				expect.stringContaining("from 1 to 2147483647"),
				expect.stringContaining("ignored the supplier price"),
			],
		});
		expect(first("Each", "2147483647")).toMatchObject({
			unit: "PACK",
			packSize: 2147483647,
		});
		expect(first("Each", "2147483648")).toMatchObject({
			...each,
			cost: null,
			warnings: [
				expect.stringContaining("from 1 to 2147483647"),
				expect.stringContaining("ignored the supplier price"),
			],
		});
		// A bad unit name keeps a good pack size under PACK, and its price.
		expect(first("A unit name over twenty characters", "2")).toMatchObject({
			unit: "PACK",
			packSize: 2,
			cost: 200,
			warnings: [
				expect.stringContaining("too long"),
				"Units used, added if katasync doesn't have them yet: PACK",
			],
		});
		// With no pack to keep, the unit and its price are both unknown.
		expect(first("A unit name over twenty characters", "")).toMatchObject({
			...each,
			cost: null,
			warnings: [
				expect.stringContaining("too long"),
				expect.stringContaining("ignored the supplier price"),
			],
		});
		// A case price is checked against the whole case, not one product.
		expect(first("Case", "12", "2400")).toMatchObject({ cost: 2400 });
		expect(first("Case", "12", "200").cost).toBeNull();
	});

	test("drops the supplier price when the pack is unreadable, even with no catalog cost", () => {
		// "05-158" has no cost in the catalog, so nothing else would catch it.
		const plan = planSupplierImport(
			{
				...files,
				links: `${linksHeader}\n2,Knife,,'05-158,USD,MMC,True,,Case,twelve,Per Unit,24.0000,0.0000,1,`,
			},
			catalog,
		);
		expect(plan.links).toEqual([
			expect.objectContaining({
				sku: "05-158",
				unit: "EACH",
				packSize: 1,
				cost: null,
			}),
		]);
	});

	test("fails on a link to a supplier that isn't in the file", () => {
		expect(() =>
			planSupplierImport(
				{
					...files,
					links: `${files.links}\n5,X,,ROLLER2,USD,NOPE,True,,,1,Per Unit,0,0,1,`,
				},
				catalog,
			),
		).toThrow(/ROLLER2: unknown supplier NOPE/);
	});
});

test("minimumFromNotes reads Sumtracker's free-text minimums", () => {
	expect(minimumFromNotes("Free Shipping Min - $1500")).toBe(1500);
	expect(minimumFromNotes("SHIP MIN 900")).toBe(900);
	expect(minimumFromNotes("Minimum $1,250.50 for free freight")).toBe(1250.5);
	expect(minimumFromNotes("Call Linda before ordering")).toBeNull();
});

// First test in the file to build a database, which can take a few seconds
// when the whole suite runs at once.
test("applySupplierImport writes suppliers and links once", {
	timeout: 20_000,
}, async () => {
	const db = await createTestDb();
	const roller = await createProduct(db, "ROLLER", "simple");
	await createProduct(db, "05-158", "simple");
	await createProduct(db, "SPONGE", "simple");
	const blade = await createProduct(db, "BLADE", "simple");
	await createProduct(db, "TAPE", "simple");
	await createProduct(db, "GLOVES", "simple");
	const plan = planSupplierImport(files, catalog);

	expect(await applySupplierImport(db, plan)).toEqual({
		suppliers: 2,
		links: 6,
		// CASE came with the migration.
		unitsCreated: ["BAG OF 50"],
	});
	const links = await db.select().from(schema.productSuppliers);
	expect(links.find((l) => l.productId === roller)).toMatchObject({
		supplierSku: "J1100",
		cost: 222.7,
		minimumQuantity: 6,
		unit: "EACH",
		packSize: 1,
	});
	expect(links.find((l) => l.productId === blade)).toMatchObject({
		unit: "CASE",
		packSize: 12,
		cost: 24,
		minimumQuantity: 2,
	});
	const units = await db.select().from(schema.purchaseUnits);
	expect(units.map((u) => u.name).sort()).toEqual([
		"BAG OF 50",
		"BOX",
		"CASE",
		"EACH",
		"PACK",
	]);
	await expect(applySupplierImport(db, plan)).rejects.toThrow(
		/already has 2 suppliers/,
	);
});
