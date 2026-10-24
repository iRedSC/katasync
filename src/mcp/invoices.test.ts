import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { carry } from "#/purchasing/purchasing.fixtures";
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

	describe("supplier invoices", () => {
		let tsw: number;
		let po: number;
		beforeEach(async () => {
			[{ id: tsw }] = await db
				.insert(schema.suppliers)
				.values({ code: "TSW", name: "Tool Source Warehouse" })
				.returning();
			const box = await createProduct(db, "TT-EZ12TT", "simple");
			const flusher = await createProduct(db, "COL-DF25", "simple");
			const knife = await createProduct(db, "TT-TK8SSTT", "simple");
			await db
				.update(schema.products)
				// Variants need a product group; the name alone reads the same.
				.set({ name: 'Columbia Direct Corner Flusher (2.5")' })
				.where(eq(schema.products.id, flusher));
			for (const [productId, supplierSku] of [
				[blade, null],
				[box, "TTTEZ12TT"],
				[flusher, null],
				[knife, null],
			] as const) {
				await carry(db, productId, tsw);
				await db.insert(schema.productSuppliers).values({
					productId,
					supplierId: tsw,
					supplierSku,
					supplierCount: 1,
				});
			}
			const [location] = await db.select().from(schema.locations);
			const [order] = await db
				.insert(schema.purchaseOrders)
				.values({ supplierId: tsw, locationId: location.id })
				.returning();
			po = order.id;
			await db.insert(schema.purchaseOrderLines).values([
				{
					purchaseOrderId: po,
					productId: box,
					supplierCount: 1,
					quantity: 15,
					unitCost: 284,
				},
				{
					purchaseOrderId: po,
					productId: flusher,
					supplierCount: 1,
					quantity: 10,
					unitCost: 76.37,
				},
				{
					purchaseOrderId: po,
					productId: knife,
					unit: "BOX",
					packSize: 10,
					supplierCount: 10,
					quantity: 2,
					unitCost: 67.2,
				},
				{
					purchaseOrderId: po,
					productId: blade,
					supplierCount: 1,
					quantity: 4,
					unitCost: 1.5,
				},
			]);
		});

		test("a PO reads with its totals and without images", async () => {
			const { data } = await tool("get_purchase_order", { id: po });
			expect(data.totals).toEqual({
				lines: 4,
				quantity: 31,
				items: 49,
				total: 5164.1,
				linesWithoutPrice: 0,
				received: 0,
			});
			expect(data.lines[0]).not.toHaveProperty("imageUrl");
			expect(data.invoices).toEqual([]);
		});

		test("matching reports each difference and changes nothing", async () => {
			const { data } = await tool("match_invoice", {
				po,
				invoice_number: "TSW-INV-1",
				total: 5467.1,
				lines: [
					{
						supplier_sku: "TTTEZ12TT",
						description: 'TapeTech Flat Box (12")',
						quantity: 16,
						unit_cost: 284,
					},
					{
						description: 'Columbia Direct Corner Flusher (2.5")',
						quantity: 10,
						unit_cost: 78.37,
					},
					{
						supplier_sku: "TTTK8",
						description: "TT-TK8SSTT",
						quantity: 2,
						unit_cost: 67.2,
					},
					{ description: "Something else", quantity: 1, unit_cost: 5 },
				],
			});
			expect(data.matches).toBe(false);
			expect(data.warning).toMatch(/still a draft/);
			expect(data.differences).toMatchObject([
				{
					line: 1,
					sku: "TT-EZ12TT",
					matchedBy: "supplier_sku",
					issues: ["quantity"],
					amountOver: 284,
				},
				{
					line: 2,
					sku: "COL-DF25",
					matchedBy: "description",
					issues: ["price"],
					amountOver: 20,
				},
			]);
			expect(data.notOnPo).toMatchObject([
				{ line: 4, reason: "not on the PO" },
			]);
			expect(data.notOnInvoice).toMatchObject([{ sku: "BLADE", quantity: 4 }]);
			expect(data.supplierSkusToSave).toEqual([
				{ sku: "TT-TK8SSTT", supplierSku: "TTTK8" },
			]);
			expect(data.totals).toMatchObject({
				matchingLines: 1,
				poTotal: 5164.1,
				invoiceLinesTotal: 5467.1,
				invoiceOverPo: 303,
				invoiceArithmeticOff: 0,
			});
			const [line] = await db
				.select()
				.from(schema.purchaseOrderLines)
				.where(eq(schema.purchaseOrderLines.unitCost, 284));
			expect(line.quantity).toBe(15);
		});

		test("a description that fits two lines matches neither", async () => {
			await db.update(schema.products).set({ name: "Same" });
			const { data } = await tool("match_invoice", {
				po,
				lines: [{ description: "Same", quantity: 1, unit_cost: 1 }],
			});
			expect(data.notOnPo[0].reason).toMatch(/^description fits /);
		});

		test("an invoice is kept once, only on a PO that's on order", async () => {
			const record = (number: string) =>
				tool("record_supplier_invoice", {
					po,
					number,
					invoiced_on: "2026-10-17",
					due_on: "2026-11-16",
					total: 5458.4,
				});
			expect((await record("TSW-INV-1")).data).toMatch(
				/is a draft, not on order/,
			);
			const sent = await tool("mark_po_sent", { po, sent_on: "2000-01-01" });
			expect(sent.data).toMatch(/was made on/);
			await tool("mark_po_sent", { po });
			const [order] = await db.select().from(schema.purchaseOrders);
			expect(order).toMatchObject({ status: "sent", sentTo: null });
			expect((await record("TSW-INV-1")).isError).toBe(false);
			expect((await record(" tsw-inv-1 ")).data).toMatch(
				/already recorded on PO/,
			);
			const { data } = await tool("get_purchase_order", { id: po });
			expect(data.invoices).toMatchObject([
				{
					number: "TSW-INV-1",
					invoicedOn: "2026-10-17",
					dueOn: "2026-11-16",
					total: 5458.4,
				},
			]);
			const again = await tool("match_invoice", {
				po,
				invoice_number: "TSW-INV-1",
				lines: [{ sku: "BLADE", quantity: 4, unit_cost: 1.5 }],
			});
			expect(again.data.alreadyRecorded).toMatch(/already recorded/);
			await tool("void_supplier_invoice", { id: data.invoices[0].id });
			expect(await db.select().from(schema.supplierInvoices)).toHaveLength(1);
			expect((await tool("po_payables", { po })).data.invoices[0].voided).toBe(
				true,
			);
			await tool("restore_supplier_invoice", { id: data.invoices[0].id });
			expect((await tool("po_payables", { po })).data.invoices[0].voided).toBe(
				false,
			);
		});

		test("item numbers fill in only for that supplier's products, keeping others", async () => {
			const other = await createProduct(db, "ELSEWHERE", "simple");
			const [{ id: canam }] = await db
				.insert(schema.suppliers)
				.values({ code: "CANAM", name: "CanAm" })
				.returning();
			await carry(db, other, canam);
			await db
				.insert(schema.productSuppliers)
				.values({ productId: other, supplierId: canam, supplierCount: 1 });
			const { data } = await tool("set_supplier_skus", {
				supplier: "tsw",
				items: [
					{ sku: "BLADE", supplier_sku: " BLD1 " },
					{ sku: "TT-EZ12TT", supplier_sku: "OTHER" },
					{ sku: "ELSEWHERE", supplier_sku: "X" },
					{ sku: "NOPE", supplier_sku: "Y" },
				],
			});
			expect(data).toEqual({
				filled: [{ sku: "BLADE", supplierSku: "BLD1", was: null }],
				unchanged: [],
				kept: [{ sku: "TT-EZ12TT", ours: "TTTEZ12TT", given: "OTHER" }],
				skipped: [
					{ sku: "NOPE", reason: "no such SKU" },
					{
						sku: "ELSEWHERE",
						reason:
							"this supplier doesn't sell it (catalog not carried, or marked unavailable)",
					},
				],
			});
		});
	});
});
