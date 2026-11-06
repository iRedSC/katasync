import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import type { Period } from "#/orders/sales-report";
import { createTestDb } from "#/test/db";
import { amazonStatement, amazonStatementTransaction } from "./amazon";
import { ebayStatement } from "./ebay";
import { readStatements, refreshStatement } from "./refresh";
import type { Statement } from "./types";
import { monthWindow, PACIFIC } from "./window";

const october: Period = { year: 2026, month: 10 };
const window = monthWindow(october, PACIFIC);
// An eBay month with one sale of `gross`, so reads can be told apart.
const sold = (gross: number): Statement =>
	ebayStatement(window, [
		{
			transactionId: "1",
			transactionType: "SALE",
			bookingEntry: "CREDIT",
			amount: { value: gross },
		},
	]);
const netSales = async (db: Db) => {
	const ebay = (await readStatements(db, october)).results.find(
		(r) => r.channel === "ebay",
	);
	return ebay?.state === "read" && ebay.statement.channel === "ebay"
		? ebay.statement.netSales
		: null;
};

afterEach(() => vi.useRealTimers());

describe("refreshStatement", () => {
	let db: Db;
	beforeEach(async () => {
		db = await createTestDb();
	});

	test("keeps the read that began later when two cross", async () => {
		let finishSlow: (s: Statement) => void = () => {};
		vi.useFakeTimers({
			now: new Date("2026-11-06T12:00:00Z"),
			toFake: ["Date"],
		});
		const slow = refreshStatement(
			db,
			"ebay",
			october,
			() => new Promise((resolve) => (finishSlow = resolve)),
		);
		vi.setSystemTime(new Date("2026-11-06T12:05:00Z"));
		await refreshStatement(db, "ebay", october, async () => sold(200));
		finishSlow(sold(100));
		await slow;
		expect(await netSales(db)).toBe(200);
	});

	test("a failed read again keeps the last figures, marked as older", async () => {
		vi.useFakeTimers({
			now: new Date("2026-10-20T12:00:00Z"),
			toFake: ["Date"],
		});
		await refreshStatement(db, "ebay", october, async () => sold(100));
		vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
		const failed = await refreshStatement(db, "ebay", october, async () => {
			throw new Error("eBay answered 500");
		});
		expect(failed).toEqual({ kind: "failed", error: "eBay answered 500" });
		const [ebay] = (await readStatements(db, october)).results.filter(
			(r) => r.channel === "ebay",
		);
		expect(ebay).toMatchObject({
			state: "read",
			// Read on Oct 20: the month so far.
			complete: false,
			lastError: "eBay answered 500",
		});
		// Read again after the month ended, it's the month's.
		await refreshStatement(db, "ebay", october, async () => sold(120));
		const [again] = (await readStatements(db, october)).results.filter(
			(r) => r.channel === "ebay",
		);
		expect(again).toMatchObject({ complete: true, lastError: null });
	});

	test("a month never read says why", async () => {
		await refreshStatement(db, "amazon", october, async () => {
			throw new Error("Amazon answered 403");
		});
		const amazon = (await readStatements(db, october)).results.find(
			(r) => r.channel === "amazon",
		);
		expect(amazon).toEqual({
			channel: "amazon",
			state: "missing",
			error: "Amazon answered 403",
		});
	});
});

describe("amazonStatement", () => {
	const t = (marketplaceId: string, currencyCode: string) =>
		({
			transactionType: "Shipment",
			marketplaceDetails: { marketplaceId },
			totalAmount: { currencyAmount: 10, currencyCode },
		}) as never;

	test("leaves the account's other marketplaces out", () => {
		const s = amazonStatement(window, [t("A2EUQ1WTGCTBG2", "CAD")]);
		expect(
			s.channel === "amazon" && s.sections.flatMap((x) => x.lines),
		).toEqual([]);
	});

	test("refuses to add another currency into dollars", () => {
		expect(() => amazonStatement(window, [t("ATVPDKIKX0DER", "CAD")])).toThrow(
			/CAD/,
		);
	});

	test("reads what Amazon sends as null, and splits FBA from the rest", () => {
		const sale = (fulfillmentNetwork: string | null) =>
			({
				transactionType: "Shipment",
				postedDate: null,
				marketplaceDetails: { marketplaceId: "ATVPDKIKX0DER" },
				totalAmount: { currencyAmount: 10, currencyCode: null },
				items: [{ contexts: [{ contextType: null, fulfillmentNetwork }] }],
				breakdowns: [
					{
						breakdownType: "Sales",
						breakdownAmount: { currencyAmount: 10 },
						breakdowns: [
							{
								breakdownType: "ProductCharges",
								breakdownAmount: { currencyAmount: 10 },
							},
						],
					},
				],
			}) as unknown;
		const parsed = [sale(null), sale("AFN"), sale("MFN")].map((x) =>
			amazonStatementTransaction.assert(x),
		);
		const s = amazonStatement(window, parsed);
		const lines =
			s.channel === "amazon" ? s.sections.flatMap((x) => x.lines) : [];
		expect(lines).toEqual(
			expect.arrayContaining([
				{ label: "Product sales", amount: 10 },
				{ label: "FBA product sales", amount: 10 },
				{ label: "Product sales (non-FBA)", amount: 10 },
			]),
		);
	});
});
