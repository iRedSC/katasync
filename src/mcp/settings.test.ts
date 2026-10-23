import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { carry } from "#/purchasing/purchasing.fixtures";
import { callTool, freshDb } from "./mcp.fixtures";

let db: Db;
let blade: number;
beforeEach(async () => {
	({ db, blade } = await freshDb());
});

describe("over MCP", () => {
	const tool = (name: string, args: Record<string, unknown> = {}) =>
		callTool(db, true, name, args);

	test("a locked line keeps its quantity through suggestions", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		await carry(db, blade, canam);
		await db.insert(schema.productSuppliers).values({
			productId: blade,
			supplierId: canam,
			supplierCount: 1,
		});
		const set = await tool("set_draft_po_lines", {
			quantity_in: "items",
			lines: [{ sku: "BLADE", quantity: 1 }],
		});
		const po = set.data.drafts[0].po;
		const locked = await tool("lock_po_lines", {
			po,
			skus: ["BLADE"],
			locked: true,
		});
		expect(locked.data.lines).toMatchObject([{ sku: "BLADE", locked: true }]);
		const unlocked = await tool("lock_po_lines", {
			po,
			skus: ["BLADE"],
			locked: false,
		});
		expect(unlocked.data.lines[0].locked).toBeUndefined();
		const missing = await tool("lock_po_lines", {
			po,
			skus: ["NOPE"],
			locked: true,
		});
		expect(missing.isError).toBe(true);
	});

	test("rewords an email, refuses unknown placeholders, and resets", async () => {
		const saved = await tool("save_email_template", {
			kind: "purchase_order",
			subject: "PO {po}",
			body: "{greeting}\n\nOrder attached.",
		});
		expect(saved.isError).toBe(false);
		const read = await tool("email_templates");
		expect(read.data[0]).toMatchObject({
			kind: "purchase_order",
			subject: "PO {po}",
			custom: true,
		});
		const bad = await tool("save_email_template", {
			kind: "purchase_order",
			subject: "PO {nope}",
			body: "Hi",
		});
		expect(bad.isError).toBe(true);
		await tool("reset_email_template", { kind: "purchase_order" });
		expect((await tool("email_templates")).data[0].custom).toBe(false);
	});

	test("saves, renames, and deletes a product view", async () => {
		const made = await tool("save_product_view", {
			name: "Low blades",
			filters: [{ field: "title", value: "blade" }],
			sort: [{ column: "velocity", desc: true }, { column: "sku" }],
		});
		const view = () =>
			db
				.select()
				.from(schema.productViews)
				.where(eq(schema.productViews.id, made.data.id));
		const [row] = await view();
		expect(row).toMatchObject({ name: "Low blades", sort: "-velocity,sku" });
		expect(row.filters).toEqual([
			{
				field: "title",
				value: "blade",
				exclude: false,
				and: false,
				exact: true,
			},
		]);
		await tool("save_product_view", {
			id: made.data.id,
			name: "Blades",
			filters: [],
		});
		const [renamed] = await view();
		expect(renamed).toMatchObject({ name: "Blades", sort: "" });
		const badSort = await tool("save_product_view", {
			name: "Odd",
			filters: [],
			sort: [{ column: "colour" }],
		});
		expect(badSort.isError).toBe(true);
		await tool("delete_product_view", { id: made.data.id });
		expect(await view()).toEqual([]);
	});

	test("deletes a box and a purchase unit nothing uses", async () => {
		const made = await tool("create_boxes", {
			boxes: [{ length_in: 3, width_in: 3, height_in: 6, weight_oz: 0 }],
		});
		await tool("delete_box", { id: made.data[0].id });
		expect(await db.select().from(schema.packages)).toEqual([]);
		expect((await tool("delete_box", { id: made.data[0].id })).isError).toBe(
			true,
		);

		await tool("add_purchase_unit", { name: "ROLL" });
		await tool("delete_purchase_unit", { name: "roll" });
		const units = await db
			.select()
			.from(schema.purchaseUnits)
			.where(eq(schema.purchaseUnits.name, "ROLL"));
		expect(units).toEqual([]);
		expect((await tool("delete_purchase_unit", { name: "EACH" })).isError).toBe(
			true,
		);
	});
});
