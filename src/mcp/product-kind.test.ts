import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { getAvailability } from "#/inventory/availability";
import { recordSale } from "#/inventory/ledger";
import { createProduct } from "#/test/db";
import { callTool, freshDb } from "./mcp.fixtures";

let db: Db;
let blade: number;
beforeEach(async () => {
	({ db, blade } = await freshDb());
	await createProduct(db, "HANDLE", "simple");
	await createProduct(db, "SET", "simple");
});

const tool = (name: string, args: Record<string, unknown>) =>
	callTool(db, true, name, args);

async function state(sku: string) {
	const [product] = await db
		.select()
		.from(schema.products)
		.where(eq(schema.products.sku, sku));
	const parts = await db
		.select({
			productId: schema.productComponents.componentProductId,
			quantity: schema.productComponents.quantity,
		})
		.from(schema.productComponents)
		.where(eq(schema.productComponents.parentProductId, product.id));
	return { kind: product.kind, parts: parts.length };
}

const parts = [
	{ sku: "BLADE", quantity: 1 },
	{ sku: "HANDLE", quantity: 2 },
];

describe("set_product_kind", () => {
	test("converts a simple product into a tool set and back", async () => {
		const made = await tool("set_product_kind", {
			sku: "SET",
			kind: "bundle",
			components: parts,
		});
		expect(made.isError).toBe(false);
		expect(made.data).toMatchObject({ from: "simple", kind: "bundle" });
		expect(await state("SET")).toEqual({ kind: "bundle", parts: 2 });

		await tool("set_product_kind", { sku: "SET", kind: "simple" });
		expect(await state("SET")).toEqual({ kind: "simple", parts: 0 });
	});

	test("a simple product with stock becomes a kit, keeping it", async () => {
		await tool("record_count", { sku: "SET", counted: 4 });
		const made = await tool("set_product_kind", {
			sku: "SET",
			kind: "kit",
			components: parts,
		});
		expect(made.isError).toBe(false);
		expect(await state("SET")).toEqual({ kind: "kit", parts: 2 });
		const [level] = await db
			.select({ onHand: schema.stockLevels.onHand })
			.from(schema.stockLevels)
			.innerJoin(
				schema.products,
				eq(schema.products.id, schema.stockLevels.productId),
			)
			.where(eq(schema.products.sku, "SET"));
		expect(level.onHand).toBe(4);
	});

	test("a kit becomes a tool set with new parts only if it never had stock", async () => {
		await tool("set_product_kind", {
			sku: "SET",
			kind: "kit",
			components: [{ sku: "BLADE", quantity: 1 }],
		});
		const made = await tool("set_product_kind", {
			sku: "SET",
			kind: "bundle",
			components: parts,
		});
		expect(made.isError).toBe(false);
		expect(await state("SET")).toEqual({ kind: "bundle", parts: 2 });

		// Counted to 0 it holds nothing, but its past stock still has to be
		// reversible on its own shelf.
		await createProduct(db, "KIT", "kit");
		await tool("set_components", {
			sku: "KIT",
			components: [{ sku: "BLADE", quantity: 1 }],
		});
		await tool("record_count", { sku: "KIT", counted: 1 });
		await tool("record_count", { sku: "KIT", counted: 0 });
		const refused = await tool("set_product_kind", {
			sku: "KIT",
			kind: "bundle",
			components: parts,
		});
		expect(refused.isError).toBe(true);
		expect(refused.data).toMatch(/stock history/);
		expect(await state("KIT")).toEqual({ kind: "kit", parts: 1 });
	});

	test("a part can't become what its parent can't hold", async () => {
		await createProduct(db, "KIT", "kit");
		await tool("set_components", {
			sku: "KIT",
			components: [{ sku: "BLADE", quantity: 1 }],
		});
		for (const kind of ["kit", "bundle"]) {
			const refused = await tool("set_product_kind", {
				sku: "BLADE",
				kind,
				components: [{ sku: "HANDLE", quantity: 1 }],
			});
			expect(refused.isError).toBe(true);
			expect(refused.data).toMatch(/part of KIT/);
		}
		expect(await state("BLADE")).toEqual({ kind: "simple", parts: 0 });
		expect(blade).toBeGreaterThan(0);
	});

	test("kits and tool sets need their parts; simple products take none", async () => {
		const bare = await tool("set_product_kind", { sku: "SET", kind: "kit" });
		expect(bare.isError).toBe(true);
		expect(bare.data).toMatch(/needs its components/);
		const extra = await tool("set_product_kind", {
			sku: "SET",
			kind: "simple",
			components: parts,
		});
		expect(extra.isError).toBe(true);
		expect(await state("SET")).toEqual({ kind: "simple", parts: 0 });
	});

	test("refuses a tool set an FBA listing sells", async () => {
		const [store] = await db
			.insert(schema.stores)
			.values({ channel: "amazon", name: "Amazon" })
			.returning();
		const [set] = await db
			.select({ id: schema.products.id })
			.from(schema.products)
			.where(eq(schema.products.sku, "SET"));
		await db.insert(schema.listings).values({
			storeId: store.id,
			externalId: "fba-1",
			externalSku: "SET",
			title: "Set (FBA)",
			fulfillment: "fba",
			productId: set.id,
		});
		const refused = await tool("set_product_kind", {
			sku: "SET",
			kind: "bundle",
			components: parts,
		});
		expect(refused.isError).toBe(true);
		expect(refused.data).toMatch(/FBA listings sell it/);
		expect(await state("SET")).toEqual({ kind: "simple", parts: 0 });
	});
});

describe("add_whole_sets", () => {
	test("a tool set stocks boxed sets apart from its parts and sells them first", async () => {
		await createProduct(db, "DM-SETB2", "simple");
		await tool("set_product_kind", {
			sku: "DM-SETB2",
			kind: "bundle",
			components: parts,
		});
		const made = await tool("add_whole_sets", { sku: "DM-SETB2" });
		expect(made.data).toEqual({
			tool_set: "DM-SETB2",
			whole_sets_sku: "DM-SETB2-WHOLE",
		});
		// Asked again, it's the same one.
		expect((await tool("add_whole_sets", { sku: "DM-SETB2" })).data).toEqual(
			made.data,
		);
		expect(await state("DM-SETB2")).toEqual({ kind: "bundle", parts: 2 });

		await tool("record_count", { sku: "DM-SETB2-WHOLE", counted: 3 });
		await tool("record_count", { sku: "BLADE", counted: 5 });
		await tool("record_count", { sku: "HANDLE", counted: 4 });
		const id = async (sku: string) =>
			(
				await db
					.select({ id: schema.products.id })
					.from(schema.products)
					.where(eq(schema.products.sku, sku))
			)[0].id;
		const [warehouse] = await db.select().from(schema.locations);
		const from = { locationIds: [warehouse.id], keep: null };
		const sellable = async (sku: string) =>
			(await getAvailability(db, [await id(sku)], from)).get(await id(sku));
		// Three boxes, and loose parts for two more.
		expect(await sellable("DM-SETB2")).toBe(5);
		expect(await sellable("HANDLE")).toBe(4);

		// Four sell: the three boxes, then one from parts.
		await recordSale(db, {
			productId: await id("DM-SETB2"),
			quantity: 4,
			locationId: warehouse.id,
			reference: "order",
		});
		expect(await sellable("DM-SETB2-WHOLE")).toBe(0);
		expect(await sellable("BLADE")).toBe(4);
		expect(await sellable("HANDLE")).toBe(2);
		expect(await sellable("DM-SETB2")).toBe(1);
	});

	test("refuses a product that isn't a tool set", async () => {
		const refused = await tool("add_whole_sets", { sku: "BLADE" });
		expect(refused.isError).toBe(true);
	});
});
