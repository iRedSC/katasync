import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
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

	test("receives a sent PO in its unit and undoes it", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const [location] = await db.select().from(schema.locations);
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "sent" })
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po.id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			quantity: 2,
		});
		const got = await tool("receive_po_line", {
			po: po.id,
			sku: "BLADE",
			quantity: 1,
		});
		expect(got.data).toMatchObject({ closed: false });
		const [level] = await db.select().from(schema.stockLevels);
		expect(level.onHand).toBe(12);
		await tool("undo_po_receipt", { receipt_id: got.data.receiptId });
		const [after] = await db.select().from(schema.stockLevels);
		expect(after.onHand).toBe(0);
	});

	test("reports damage with a photo link, and takes it back", async () => {
		vi.stubEnv("AUTH_ORIGIN", "https://katasync.test");
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const [location] = await db.select().from(schema.locations);
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "sent" })
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po.id,
			productId: blade,
			supplierCount: 1,
			quantity: 2,
		});
		await tool("receive_po_line", { po: po.id, sku: "BLADE", quantity: 2 });
		const got = await tool("report_damage", {
			po: po.id,
			sku: "BLADE",
			quantity: 1,
			description: "handle snapped",
		});
		expect(got.data.photoUpload.url).toMatch(
			/^https:\/\/katasync\.test\/api\/uploads\/damage\/[\w-]{43}$/,
		);
		const shown = await tool("get_purchase_order", { id: po.id });
		expect(shown.data.damages).toEqual([
			{
				damageId: got.data.damageId,
				sku: "BLADE",
				quantity: 1,
				description: "handle snapped",
				photos: 0,
			},
		]);
		const [level] = await db.select().from(schema.stockLevels);
		expect(level.onHand).toBe(1);
		await tool("remove_damage", { damage_id: got.data.damageId });
		const [after] = await db.select().from(schema.stockLevels);
		expect(after.onHand).toBe(2);
		vi.unstubAllEnvs();
	});

	test("notes a line for receiving, and takes the note off", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const [location] = await db.select().from(schema.locations);
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "sent" })
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po.id,
			productId: blade,
			supplierCount: 1,
			quantity: 2,
		});
		const set = await tool("set_po_line_note", {
			po: po.id,
			sku: "BLADE",
			note: "  1 crushed, kept  ",
		});
		expect(set.data).toMatchObject({ was: null, note: "1 crushed, kept" });
		const shown = await tool("get_purchase_order", { id: po.id });
		expect(shown.data.lines[0].receivingNote).toBe("1 crushed, kept");
		const cleared = await tool("set_po_line_note", {
			po: po.id,
			sku: "BLADE",
			note: " ",
		});
		expect(cleared.data).toMatchObject({ was: "1 crushed, kept", note: null });
		await db
			.update(schema.purchaseOrders)
			.set({ status: "draft" })
			.where(eq(schema.purchaseOrders.id, po.id));
		const onDraft = await tool("set_po_line_note", {
			po: po.id,
			sku: "BLADE",
			note: "x",
		});
		expect(onDraft.isError).toBe(true);
	});
});
