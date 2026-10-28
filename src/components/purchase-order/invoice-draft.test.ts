import { describe, expect, it } from "vitest";
import { type Draft, type Row, readInvoice } from "./invoice-draft";

const row = (key: number, item: string, quantity: string, unitCost: string) =>
	({ key, item, quantity, unitCost }) satisfies Row;
const spare = row(99, "", "", "");

const draft = (over: Partial<Draft> = {}): Draft => ({
	purchaseOrderId: 7,
	number: "INV-1",
	invoicedOn: "2026-10-01",
	dueOn: "",
	total: "120",
	freight: "",
	tax: "",
	credits: "",
	rows: [row(1, "ABC-1", "2", "50"), spare],
	...over,
});

const skus = new Set(["abc1"]);

describe("readInvoice", () => {
	it("records every typed line and charge", () => {
		const r = readInvoice(
			draft({ freight: "$15", tax: "5", credits: "0" }),
			skus,
		);
		expect(r.record).toEqual({
			kind: "ready",
			data: {
				purchaseOrderId: 7,
				number: "INV-1",
				invoicedOn: "2026-10-01",
				dueOn: null,
				total: 120,
				freight: 15,
				tax: 5,
				lines: [{ line: 1, sku: "ABC-1", quantity: 2, unitCost: 50 }],
			},
		});
	});

	it("refuses to record a row it can't read rather than leaving it out", () => {
		const r = readInvoice(
			draft({
				rows: [
					row(1, "ABC-1", "2", "50"),
					row(2, "XYZ", "two", "10"),
					row(3, "", "1", "4"),
					spare,
				],
			}),
			skus,
		);
		expect(r.record.kind).toBe("invalid");
		if (r.record.kind !== "invalid") return;
		expect(r.record.problems.rows).toEqual(
			new Map([
				[2, new Set(["quantity"])],
				[3, new Set(["item"])],
			]),
		);
		// The lines that do read are still checked as they're typed.
		expect(r.check?.lines).toEqual([
			{ line: 1, sku: "ABC-1", quantity: 2, unitCost: 50 },
		]);
	});

	it("refuses to record a charge it can't read rather than leaving it out", () => {
		const r = readInvoice(
			draft({ freight: "12..5", tax: "abc", credits: "-3" }),
			skus,
		);
		expect(r.record.kind).toBe("invalid");
		if (r.record.kind !== "invalid") return;
		expect(r.record.problems.header).toEqual(
			new Set(["freight", "tax", "credits"]),
		);
	});

	it("records a header-only invoice only when every row is blank", () => {
		const header = readInvoice(draft({ rows: [spare] }), skus);
		expect(header.record.kind).toBe("ready");
		expect(header.check).toBeNull();
		const half = readInvoice(draft({ rows: [row(1, "ABC-1", "", "")] }), skus);
		expect(half.record.kind).toBe("invalid");
	});

	it("needs a number, a date, a total, and a due date after the date", () => {
		const r = readInvoice(
			draft({ number: " ", invoicedOn: "", total: "" }),
			skus,
		);
		expect(r.record.kind === "invalid" && r.record.problems.header).toEqual(
			new Set(["number", "invoicedOn", "total"]),
		);
		const due = readInvoice(draft({ dueOn: "2026-09-01" }), skus);
		expect(due.record.kind === "invalid" && due.record.problems.header).toEqual(
			new Set(["dueOn"]),
		);
	});

	it("matches a supplier's item number when it isn't one of our SKUs", () => {
		const r = readInvoice(draft({ rows: [row(1, "S-9", "1", "120")] }), skus);
		expect(r.record.kind === "ready" && r.record.data.lines).toEqual([
			{ line: 1, supplierSku: "S-9", quantity: 1, unitCost: 120 },
		]);
	});
});
