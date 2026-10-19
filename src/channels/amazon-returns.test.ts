import { describe, expect, test } from "vitest";
import { parseReturnsReport, returnStatus } from "./amazon-returns";

const HEADER = [
	"Order ID",
	"Order date",
	"Return request date",
	"Return request status",
	"Amazon RMA ID",
	"Tracking ID",
	"Return carrier",
	"Merchant SKU",
	"Return quantity",
	"Return Reason",
	"Return delivery date",
	"Order Item ID",
].join("\t");

const row = (cells: Partial<Record<string, string>>) =>
	HEADER.split("\t")
		.map((c) => cells[c] ?? "")
		.join("\t");

describe("parseReturnsReport", () => {
	test("groups an RMA's items and reads its stage", () => {
		const { returns, problems } = parseReturnsReport(
			[
				`﻿${HEADER}`,
				row({
					"Order ID": "111-1",
					"Return request date": "2026-09-01T10:00:00Z",
					"Return request status": "Approved",
					"Amazon RMA ID": "RMA1",
					"Tracking ID": "1Z9",
					"Merchant SKU": "WRENCH",
					"Return quantity": "1",
					"Return Reason": "DEFECTIVE",
					"Order Item ID": "OI-1",
				}),
				row({
					"Order ID": "111-1",
					"Return request date": "2026-09-01T10:00:00Z",
					"Return request status": "Approved",
					"Amazon RMA ID": "RMA1",
					"Merchant SKU": "HAWK",
					"Return quantity": "2",
					"Order Item ID": "OI-2",
				}),
				row({
					"Order ID": "111-2",
					"Return request date": "soon",
					"Return quantity": "1",
				}),
				"",
			].join("\n"),
		);
		expect(problems).toEqual(["Amazon return for 111-2 has no date"]);
		expect(returns).toHaveLength(1);
		expect(returns[0]).toMatchObject({
			externalId: "RMA1",
			status: "shipped",
			reason: "DEFECTIVE",
			lines: [
				{ lineExternalId: "OI-1", sku: "WRENCH", quantity: 1 },
				{ lineExternalId: "OI-2", sku: "HAWK", quantity: 2 },
			],
		});
	});

	test("a renamed column fails instead of reading as blank", () => {
		expect(() => parseReturnsReport("Order ID\tReturn date\n")).toThrow(
			"has no Return request date",
		);
	});

	test("statuses", () => {
		const s = (status: string, delivered = false, tracked = false) =>
			returnStatus({ status, delivered, tracked });
		expect(s("Rejected", true)).toBe("cancelled");
		expect(s("Closed", true)).toBe("closed");
		expect(s("Approved", true, true)).toBe("delivered");
		expect(s("Pending")).toBe("requested");
	});
});
