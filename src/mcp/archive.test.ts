import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { autoMapListings, syncListings } from "#/channels/listings";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { callTool, freshDb } from "./mcp.fixtures";

let db: Db;
let blade: number;
beforeEach(async () => {
	({ db, blade } = await freshDb());
});

const tool = (name: string, args: Record<string, unknown>) =>
	callTool(db, true, name, args);

async function listing(productId: number | null, status: string | null) {
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: `Shop ${status}` })
		.returning();
	const [row] = await db
		.insert(schema.listings)
		.values({
			storeId: store.id,
			externalId: `v-${status}`,
			externalSku: "BLADE",
			title: `Blade (${status})`,
			status,
			productId,
		})
		.returning();
	return row.id;
}

describe("archive_product", () => {
	test("refuses, saying why, while the product is still active", async () => {
		const live = await listing(blade, "ACTIVE");
		await tool("record_count", { sku: "BLADE", counted: 3 });
		const kit = await createProduct(db, "KIT", "kit");
		await tool("set_components", {
			sku: "KIT",
			components: [{ sku: "BLADE", quantity: 1 }],
		});
		const refused = await tool("archive_product", { sku: "BLADE" });
		expect(refused.isError).toBe(true);
		expect(refused.data).toMatch(/live listings sell it/);
		expect(refused.data).toMatch(/3 on hand at Warehouse/);
		expect(refused.data).toMatch(/part of KIT/);

		await db
			.update(schema.listings)
			.set({ status: "ARCHIVED" })
			.where(eq(schema.listings.id, live));
		await tool("record_count", { sku: "BLADE", counted: 0 });
		await tool("archive_product", { sku: "KIT" });
		const done = await tool("archive_product", { sku: "BLADE" });
		expect(done.isError).toBe(false);
		expect(kit).toBeGreaterThan(0);
	});

	test("hides it from matching, counting, and kits until restored", async () => {
		await tool("archive_product", { sku: "BLADE" });
		const loose = await listing(null, "ACTIVE");
		await autoMapListings(db);
		const [row] = await db
			.select()
			.from(schema.listings)
			.where(eq(schema.listings.id, loose));
		expect(row.productId).toBeNull();

		await createProduct(db, "KIT", "kit");
		const part = await tool("set_components", {
			sku: "KIT",
			components: [{ sku: "BLADE", quantity: 1 }],
		});
		expect(part.data).toMatch(/archived/);
		const ask = await tool("request_counts", { skus: ["BLADE"] });
		expect(ask.isError).toBe(true);
		const due = await tool("counts_due", {});
		expect(JSON.stringify(due.data)).not.toMatch(/BLADE/);

		await tool("restore_product", { sku: "BLADE" });
		expect(await autoMapListings(db)).toEqual([loose]);
	});
});

describe("delete_product", () => {
	test("deletes a product with no history", async () => {
		const made = await createProduct(db, "OOPS", "simple");
		expect((await tool("delete_product", { sku: "OOPS" })).isError).toBe(false);
		const left = await db
			.select()
			.from(schema.products)
			.where(eq(schema.products.id, made));
		expect(left).toHaveLength(0);
	});

	test("refuses one with history, pointing to archive", async () => {
		await tool("record_count", { sku: "BLADE", counted: 2 });
		await listing(blade, "ACTIVE");
		const refused = await tool("delete_product", { sku: "BLADE" });
		expect(refused.isError).toBe(true);
		expect(refused.data).toMatch(/listings sell it, stock moved/);
		expect(refused.data).toMatch(/Archive it instead/);
	});
});

describe("after archiving", () => {
	test("a kit comes back only once its parts do", async () => {
		await createProduct(db, "KIT", "kit");
		await tool("set_components", {
			sku: "KIT",
			components: [{ sku: "BLADE", quantity: 1 }],
		});
		await tool("archive_product", { sku: "KIT" });
		await tool("archive_product", { sku: "BLADE" });
		const early = await tool("restore_product", { sku: "KIT" });
		expect(early.data).toMatch(/BLADE are archived/);
		await tool("restore_product", { sku: "BLADE" });
		expect((await tool("restore_product", { sku: "KIT" })).isError).toBe(false);
	});

	test("a listing back on sale is unmatched from it", async () => {
		const id = await listing(blade, "ARCHIVED");
		await tool("archive_product", { sku: "BLADE" });
		const [{ storeId }] = await db
			.select()
			.from(schema.listings)
			.where(eq(schema.listings.id, id));
		const again = (status: string, sku = "BLADE") =>
			syncListings(db, storeId, [
				{
					externalId: "v-ARCHIVED",
					externalSku: sku,
					title: "Blade",
					fulfillment: "merchant",
					status,
				},
			]);
		const productOf = async () =>
			(
				await db
					.select()
					.from(schema.listings)
					.where(eq(schema.listings.id, id))
			)[0].productId;
		await again("ARCHIVED", " BLADE ");
		expect(await productOf()).toBe(blade);
		await again("ACTIVE");
		expect(await productOf()).toBeNull();
	});

	test("stock landing on it again keeps it countable", async () => {
		await tool("archive_product", { sku: "BLADE" });
		await tool("record_count", { sku: "BLADE", counted: 1 });
		await tool("request_counts", { skus: ["BLADE"] });
		const due = await tool("counts_due", {});
		expect(JSON.stringify(due.data)).toMatch(/BLADE/);
	});
});
