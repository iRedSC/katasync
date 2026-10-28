import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
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
