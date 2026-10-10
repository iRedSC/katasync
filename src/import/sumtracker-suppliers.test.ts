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
	].join("\n"),
};

const catalog = new Map([
	["ROLLER", { kind: "simple", unitCost: 200 }],
	["05-158", { kind: "simple", unitCost: null }],
	["SET", { kind: "bundle", unitCost: null }],
	["SPONGE", { kind: "simple", unitCost: 2 }],
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
				cost: 222.7,
				minimumQuantity: 6,
			},
			// The spreadsheet's leading ' is stripped; a zero cost means unknown.
			{
				sku: "05-158",
				supplierCode: "MMC",
				supplierSku: null,
				cost: null,
				minimumQuantity: 1,
			},
			// A case price, so it's left for the product's own cost.
			{
				sku: "SPONGE",
				supplierCode: "MMC",
				supplierSku: null,
				cost: null,
				minimumQuantity: 1,
			},
		]);
		expect(plan.warnings).toEqual([
			'CANAM: minimum order set to $1500 from its notes ("Free Shipping Min - $1500")',
			"No email for MMC; their POs can't be sent until one is added",
			"Skipped 1 links to SKUs katasync doesn't have: GONE",
			"Skipped 1 links to tool sets, which are bought as their parts: SET",
			"Ignored 1 supplier prices over twice or under half the product's cost, probably case prices: SPONGE ($140.25 vs $2)",
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

test("applySupplierImport writes suppliers and links once", async () => {
	const db = await createTestDb();
	const roller = await createProduct(db, "ROLLER", "simple");
	await createProduct(db, "05-158", "simple");
	await createProduct(db, "SPONGE", "simple");
	const plan = planSupplierImport(files, catalog);

	expect(await applySupplierImport(db, plan)).toEqual({
		suppliers: 2,
		links: 3,
	});
	const links = await db.select().from(schema.productSuppliers);
	expect(links.find((l) => l.productId === roller)).toMatchObject({
		supplierSku: "J1100",
		cost: 222.7,
		minimumQuantity: 6,
	});
	await expect(applySupplierImport(db, plan)).rejects.toThrow(
		/already has 2 suppliers/,
	);
});
