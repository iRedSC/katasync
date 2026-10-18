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
});

describe("over MCP", () => {
	let canWrite = true;
	beforeEach(() => {
		canWrite = true;
	});
	const tool = (name: string, args: Record<string, unknown>) =>
		callTool(db, canWrite, name, args);

	test("puts lines on each supplier's draft and reports what it skipped", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		await db.insert(schema.productSuppliers).values({
			productId: blade,
			supplierId: canam,
			supplierCount: 1,
			cost: 2,
			minimumQuantity: 5,
		});
		await createProduct(db, "LOOSE", "simple");
		const { data } = await tool("set_draft_po_lines", {
			quantity_in: "purchase_unit",
			lines: [
				{ sku: "BLADE", quantity: 3 },
				{ sku: "LOOSE", quantity: 1 },
				{ sku: "NOPE", quantity: 1 },
			],
		});
		expect(data.drafts).toMatchObject([
			{
				supplier: "CanAm",
				set: [
					{
						sku: "BLADE",
						quantity: 3,
						warning: "below the supplier's minimum of 5",
					},
				],
			},
		]);
		expect(data.skipped).toEqual([
			{ sku: "LOOSE", reason: "no supplier set" },
			{ sku: "NOPE", reason: "No product with SKU NOPE" },
		]);
		const [line] = await db.select().from(schema.purchaseOrderLines);
		expect(line).toMatchObject({ productId: blade, quantity: 3, unitCost: 2 });
	});

	test("deletes a draft PO but never a sent one", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const [{ id: locationId }] = await db.select().from(schema.locations);
		const [draft] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId, status: "draft" })
			.returning();
		const [sent] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId, status: "sent" })
			.returning();
		const refused = await tool("delete_draft_po", { po: sent.id });
		expect(refused).toMatchObject({ isError: true });
		expect(refused.data).toMatch(/is sent/);
		const deleted = await tool("delete_draft_po", { po: draft.id });
		expect(deleted.data).toEqual({ deleted: draft.id });
		const po = async (id: number) =>
			(
				await db
					.select()
					.from(schema.purchaseOrders)
					.where(eq(schema.purchaseOrders.id, id))
			)[0];
		expect((await po(sent.id)).status).toBe("sent");
		expect(await po(draft.id)).toBeUndefined();
	});

	test("orders items as whole packs, in a line's own unit if it has one", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		await db.insert(schema.productSuppliers).values({
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			cost: 24,
		});
		const first = await tool("set_draft_po_lines", {
			quantity_in: "items",
			lines: [{ sku: "BLADE", quantity: 30 }],
		});
		expect(first.data.drafts[0].set[0]).toMatchObject({
			quantity: 3,
			unit: "CASE",
			items: 36,
		});
		// This PO buys it in boxes of 6 instead.
		await tool("set_po_line_terms", {
			po: first.data.drafts[0].po,
			sku: "BLADE",
			unit: "BOX",
			pack_size: 6,
			minimum: 1,
		});
		const again = await tool("set_draft_po_lines", {
			quantity_in: "items",
			lines: [{ sku: "BLADE", quantity: 30 }],
		});
		expect(again.data.drafts[0].set[0]).toMatchObject({
			quantity: 5,
			unit: "BOX",
			items: 30,
		});
	});

	test("changes a sent PO to match what came, without changing what was sent", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const knife = await createProduct(db, "KNIFE", "simple");
		await db.insert(schema.productSuppliers).values({
			productId: knife,
			supplierId: canam,
			supplierCount: 1,
			cost: 9,
		});
		const [location] = await db.select().from(schema.locations);
		const [draft] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "draft" })
			.returning();
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "sent" })
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po.id,
			productId: blade,
			supplierCount: 1,
			quantity: 10,
			unitCost: 2,
			sentQuantity: 10,
			sentUnitCost: 2,
		});

		const onDraft = await tool("add_to_sent_po", {
			po: draft.id,
			sku: "KNIFE",
			quantity: 1,
		});
		expect(onDraft.data).toMatch(/is draft/);
		const twice = await tool("add_to_sent_po", {
			po: po.id,
			sku: "BLADE",
			quantity: 1,
		});
		expect(twice.data).toMatch(/already on PO .*adjust_sent_po_line/);
		const added = await tool("add_to_sent_po", {
			po: po.id,
			sku: "KNIFE",
			quantity: 3,
		});
		expect(added.data.lines).toContainEqual(
			expect.objectContaining({ sku: "KNIFE", quantity: 3, unitCost: 9 }),
		);

		const nothing = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "BLADE",
		});
		expect(nothing).toMatchObject({ isError: true });
		await tool("receive_po_line", { po: po.id, sku: "BLADE", quantity: 4 });
		const tooLow = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "BLADE",
			quantity: 3,
		});
		expect(tooLow.data).toMatch(/4 already arrived/);
		const adjusted = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "BLADE",
			quantity: 8,
			unit_cost: 2.5,
		});
		expect(adjusted.data.was).toEqual({ quantity: 10, unitCost: 2 });
		expect(adjusted.data.warning).toMatch(/old price/);
		expect(adjusted.data.po.lines).toContainEqual(
			expect.objectContaining({
				sku: "BLADE",
				quantity: 8,
				unitCost: 2.5,
				sent: { quantity: 10, unitCost: 2 },
			}),
		);

		// A line added after sending that never arrived comes off at 0.
		const gone = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "KNIFE",
			quantity: 0,
		});
		expect(gone.data.removed).toBe("KNIFE");
		expect(gone.data.po.lines.map((l: { sku: string }) => l.sku)).toEqual([
			"BLADE",
		]);
		const amendments = await db
			.select({ kind: schema.purchaseOrderAmendments.kind })
			.from(schema.purchaseOrderAmendments)
			.orderBy(schema.purchaseOrderAmendments.id);
		expect(amendments.map((a) => a.kind)).toEqual([
			"added",
			"quantity",
			"cost",
			"removed",
		]);
	});
});
