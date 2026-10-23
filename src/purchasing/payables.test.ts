import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import {
	supplierInvoiceLines,
	supplierPaymentApplications,
} from "#/db/payables-schema";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { invoicesOf, recordInvoice, restoreInvoice, voidInvoice } from "./invoices";
import { receive, undoReceipt } from "./orders";
import {
	applyCredit,
	assertOpeningHistory,
	paymentEvidence,
	recordPayment,
	reversePayment,
	unapplyPayment,
} from "./payables";

let db: Db;
let poId: number;
let lineId: number;
let supplierId: number;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(async () => {
	db = await createTestDb();
	const blade = await createProduct(db, "BLADE", "simple");
	const [supplier] = await db
		.insert(schema.suppliers)
		.values({ code: "CANAM", name: "CanAm" })
		.returning();
	supplierId = supplier.id;
	const [location] = await db
		.insert(schema.locations)
		.values({ name: "Shop", kind: "owned" })
		.returning();
	const [po] = await db
		.insert(schema.purchaseOrders)
		.values({ supplierId, locationId: location.id, status: "sent" })
		.returning();
	poId = po.id;
	const [line] = await db
		.insert(schema.purchaseOrderLines)
		.values({
			purchaseOrderId: po.id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			quantity: 4,
			unitCost: 24,
		})
		.returning();
	lineId = line.id;
});

const bill = (number: string, cases: number) =>
	recordInvoice(db, {
		purchaseOrderId: poId,
		number,
		invoicedOn: "2026-10-20",
		total: cases * 24,
		lines: [{ kind: "merchandise", line: 1, sku: "BLADE", quantity: cases, unitCost: 24 }],
	});

const matchOf = async (number: string) =>
	(await invoicesOf(db, poId)).find((i) => i.number === number)?.match;

describe("receipt-matched invoices", () => {
	test("two partial bills each match what had been received", async () => {
		await receive(db, { lineId, quantity: 2 });
		expect((await bill("INV-1", 2)).match.kind).toBe("matched");
		await receive(db, { lineId, quantity: 2 });
		expect((await bill("INV-2", 2)).match.kind).toBe("matched");
		const lines = await db.select().from(supplierInvoiceLines);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			kind: "merchandise",
			poLineId: lineId,
			unit: "CASE",
			packSize: 12,
			unitPrice: 24,
			amountCents: 4800,
		});
	});

	test("undoing a receipt turns the bill that relied on it into an exception", async () => {
		await receive(db, { lineId, quantity: 2 });
		const { receiptId } = await receive(db, { lineId, quantity: 2 });
		await bill("INV-1", 2);
		await bill("INV-2", 2);
		await undoReceipt(db, receiptId);
		expect((await matchOf("INV-1"))?.kind).toBe("matched");
		expect(await matchOf("INV-2")).toMatchObject({
			kind: "exception",
			discrepancies: [{ kind: "beyond_received", billedItems: 24, matchedItems: 0 }],
		});
	});

	test("billing more than arrived is kept as an exception, never matched", async () => {
		await receive(db, { lineId, quantity: 1 });
		const saved = await bill("INV-1", 2);
		expect(saved.match.kind).toBe("exception");
		expect(await db.select().from(schema.supplierInvoices)).toHaveLength(1);
	});

	test("bills racing for the same units can't both match", async () => {
		await receive(db, { lineId, quantity: 2 });
		await Promise.all([bill("INV-1", 2), bill("INV-2", 2)]);
		const kinds = (await invoicesOf(db, poId)).map((i) => i.match.kind).sort();
		expect(kinds).toEqual(["exception", "matched"]);
	});

	test("a header without lines is unverified, and given lines are kept", async () => {
		const header = await recordInvoice(db, {
			purchaseOrderId: poId,
			number: "INV-H",
			invoicedOn: "2026-10-20",
			total: 10,
		});
		expect(header.match.kind).toBe("header_only");
		expect(header.payment.kind).toBe("unpaid");
		await bill("INV-L", 1);
		expect(await db.select().from(supplierInvoiceLines)).toHaveLength(1);
	});
});

describe("void and restore", () => {
	test("a number stays taken while void and comes back on the same invoice", async () => {
		await receive(db, { lineId, quantity: 2 });
		const first = await bill("INV-1", 2);
		await expect(bill(" inv-1 ", 2)).rejects.toThrow(/already recorded/);
		await voidInvoice(db, { id: first.id });
		expect((await voidInvoice(db, { id: first.id })).releasedCents).toBe(0);
		await expect(bill("INV-1", 2)).rejects.toThrow(/voided .* Restore it there/);
		const back = await restoreInvoice(db, { id: first.id });
		expect(back.id).toBe(first.id);
		expect(back.match.kind).toBe("matched");
		expect(await db.select().from(schema.supplierInvoices)).toHaveLength(1);
	});
});

describe("payment records", () => {
	test("partial payments, unapplying, reversal, and credit conserve cents", async () => {
		await receive(db, { lineId, quantity: 2 });
		const inv = await bill("INV-1", 2);
		const first = {
			id: uuid(1),
			supplierId,
			amountCents: 3000,
			paidOn: "2026-10-21",
			method: "ach" as const,
			applications: [{ id: uuid(11), invoiceId: inv.id, amountCents: 3000 }],
		};
		await recordPayment(db, first);
		await recordPayment(db, first);
		expect(await db.select().from(supplierPaymentApplications)).toHaveLength(1);
		await expect(recordPayment(db, { ...first, amountCents: 3100 })).rejects.toThrow(
			/recorded differently/,
		);
		expect((await invoicesOf(db, poId))[0].payment).toEqual({
			kind: "partial",
			totalCents: 4800,
			paidCents: 3000,
			openCents: 1800,
		});

		const second = await recordPayment(db, {
			id: uuid(2),
			supplierId,
			amountCents: 5000,
			paidOn: "2026-10-22",
			method: "check",
			reference: "1043",
			applications: [{ id: uuid(21), invoiceId: inv.id, amountCents: 1800 }],
		});
		expect(second.unappliedCents).toBe(3200);
		expect((await invoicesOf(db, poId))[0].payment.kind).toBe("paid");
		await expect(
			applyCredit(db, { id: uuid(22), paymentId: uuid(2), invoiceId: inv.id, amountCents: 1 }),
		).rejects.toThrow(/open/);

		await unapplyPayment(db, { applicationId: uuid(21) });
		await unapplyPayment(db, { applicationId: uuid(21) });
		const [, credit] = await paymentEvidence(db, { supplierId });
		expect(credit.unappliedCents).toBe(5000);

		const reversed = await reversePayment(db, { paymentId: uuid(1), reason: "entered twice" });
		expect(reversed).toMatchObject({ state: { kind: "reversed" }, unappliedCents: 0 });
		expect((await invoicesOf(db, poId))[0].payment.kind).toBe("unpaid");

		await applyCredit(db, { id: uuid(23), paymentId: uuid(2), invoiceId: inv.id, amountCents: 4800 });
		const { releasedCents } = await voidInvoice(db, { id: inv.id });
		expect(releasedCents).toBe(4800);
		const evidence = await paymentEvidence(db, { supplierId });
		const recorded = evidence.filter((p) => p.state.kind === "recorded");
		expect(recorded.reduce((n, p) => n + p.unappliedCents + p.appliedCents, 0)).toBe(5000);
		expect(evidence.every((p) => p.source === "staff_recorded")).toBe(true);
	});

	test("a legacy invoice's earlier payments stay unknown until someone says", async () => {
		const [legacy] = await db
			.insert(schema.supplierInvoices)
			.values({
				purchaseOrderId: poId,
				supplierId,
				number: "OLD-1",
				invoicedOn: "2026-01-02",
				total: 100,
			})
			.returning();
		const [before] = await invoicesOf(db, poId);
		expect(before.match.kind).toBe("legacy");
		expect(before.payment.kind).toBe("unknown");
		const asserted = await assertOpeningHistory(db, { invoiceId: legacy.id, paidCents: 0 });
		expect(asserted.invoices[0].payment.kind).toBe("unpaid");
		await expect(
			assertOpeningHistory(db, { invoiceId: legacy.id, paidCents: 10_000 }),
		).rejects.toThrow(/withdraw it first/);
		const recorded = await recordInvoice(db, {
			purchaseOrderId: poId,
			number: "NEW-1",
			invoicedOn: "2026-10-20",
			total: 5,
		});
		await expect(
			assertOpeningHistory(db, { invoiceId: recorded.id, paidCents: 0 }),
		).rejects.toThrow(/payments are known/);
	});

	test("nothing here can move money", () => {
		for (const file of [
			"src/purchasing/payables.ts",
			"src/purchasing/invoice-records.ts",
			"src/server/payables.ts",
			"src/mcp/server/invoice-tools.ts",
		]) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(/\bfetch\(|https?:\/\/|stripe|plaid|dwolla|#\/integrations/i);
		}
	});
});
