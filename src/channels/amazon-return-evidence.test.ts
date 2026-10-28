import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { totalOf } from "./amazon-return-evidence";
import { parseReturnsReport } from "./amazon-returns";

// A report with Amazon's documented columns, in its order.
const report = readFileSync(
	new URL("./fixtures/amazon-returns-report.tsv", import.meta.url),
	"utf8",
);

describe("Amazon return evidence", () => {
	const { returns, problems } = parseReturnsReport(report);
	const rma = (id: string) => {
		const found = returns.find((r) => r.externalId === id);
		if (!found) throw new Error(`no ${id}`);
		return found;
	};

	test("an A-to-z claim escalates, and a delivered return still waits on us", () => {
		expect(rma("RMA-AZ")).toMatchObject({
			status: "delivered",
			waitingOn: "us",
			escalation: "in_progress",
			amount: "42.00",
			currency: "USD",
			evidence: {
				aToZClaim: true,
				inPolicy: true,
				returnType: "C-Returns",
				resolution: "StandardRefund",
				label: {
					type: "AmazonPrePaidLabel",
					cost: { amount: "8.50", currency: "USD" },
					paidBy: "Seller",
				},
				deliveredAt: new Date("2026-10-08T15:30:00Z"),
				safetClaim: null,
			},
		});
	});

	test("a SAFE-T claim is kept whole, on a closed return out of policy", () => {
		expect(rma("RMA-ST")).toMatchObject({
			status: "closed",
			waitingOn: "nobody",
			escalation: null,
			amount: "30.00",
			evidence: {
				aToZClaim: false,
				inPolicy: false,
				safetClaim: {
					id: "ST-77",
					state: "Approved",
					reason: "Item returned damaged",
					reimbursement: { amount: "20.00", currency: "USD" },
					createdAt: "2026-10-10T09:00:00.000Z",
				},
			},
		});
	});

	test("each item of a multi-item RMA keeps its own reason, and refunds add up", () => {
		const multi = rma("RMA-MULTI");
		expect(multi.lines).toEqual([
			{
				lineExternalId: "OI-M1",
				sku: "WRENCH",
				quantity: 1,
				reason: "DEFECTIVE",
				rawStatus: "Approved",
			},
			{
				lineExternalId: "OI-M2",
				sku: "PAN",
				quantity: 2,
				reason: "UNWANTED_ITEM",
				rawStatus: "Approved",
			},
		]);
		expect(multi).toMatchObject({ amount: "15.75", currency: "USD" });
	});

	test("no refund stated is no amount, and an unknown return type is kept and named", () => {
		expect(rma("RMA-NEW")).toMatchObject({
			amount: null,
			currency: null,
			escalation: null,
			evidence: { returnType: "Z-Mystery", label: null, deliveredAt: null },
		});
		expect(problems).toEqual(["Unknown Amazon return type: Z-Mystery"]);
	});

	test("an A-to-z claim on a closed return reads as closed", () => {
		const closed = report.replace(
			"111-A\t2026-09-20T10:00:00Z\t2026-10-01T10:00:00Z\tApproved",
			"111-A\t2026-09-20T10:00:00Z\t2026-10-01T10:00:00Z\tClosed",
		);
		const az = parseReturnsReport(closed).returns.find(
			(r) => r.externalId === "RMA-AZ",
		);
		expect(az).toMatchObject({ status: "closed", escalation: "closed" });
	});

	test("an older report without the evidence columns still reads, and says so", () => {
		const header =
			"Order ID\tReturn request date\tReturn request status\tAmazon RMA ID\tTracking ID\tReturn carrier\tMerchant SKU\tReturn quantity\tReturn Reason\tReturn delivery date\tOrder Item ID";
		const row =
			"111-O\t2026-10-01T10:00:00Z\tApproved\tRMA-OLD\t\t\tWRENCH\t1\tDEFECTIVE\t\tOI-O";
		const old = parseReturnsReport(`${header}\n${row}\n`);
		// Unread, not null: the saved evidence and refund stay.
		expect(old.returns[0].amount).toBeUndefined();
		expect(old.returns[0].evidence).toEqual({
			deliveredAt: null,
			aToZClaim: undefined,
			safetClaim: undefined,
			resolution: undefined,
			inPolicy: undefined,
			returnType: undefined,
			label: undefined,
			refunded: undefined,
		});
		expect(old.problems).toHaveLength(1);
		expect(old.problems[0]).toMatch(/has no A-to-Z Claim, SafeT Action reason/);
	});

	test("a total is only stated when every item states one in one currency", () => {
		const usd = (amount: string) => ({ amount, currency: "USD" });
		expect(totalOf([usd("1.10"), usd("2.2")])).toEqual(usd("3.30"));
		expect(totalOf([usd("1.10"), null])).toBeNull();
		expect(totalOf([usd("1"), { amount: "1", currency: "CAD" }])).toBeNull();
	});
});
