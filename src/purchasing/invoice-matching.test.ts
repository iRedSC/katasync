import { describe, expect, test } from "vitest";
import {
	type BillablePoLine,
	centsOf,
	currencyOf,
	type MatchableInvoice,
	type MatchableLine,
	matchBilling,
	MoneyError,
	openCentsOf,
	paymentState,
	priceUnits,
	wholeCents,
} from "./invoice-matching";

const blade = (receivedUnits: number): BillablePoLine => ({
	id: 1,
	sku: "BLADE",
	packSize: 12,
	receivedUnits,
	prices: [24],
});

const bill = (
	id: number,
	lines: MatchableLine[],
	extra: Partial<MatchableInvoice> = {},
): MatchableInvoice => ({
	id,
	totalCents: lines.reduce(
		(n, l) => n + (l.kind === "credit" ? -l.amountCents : l.amountCents),
		0,
	),
	activeSince: new Date(2026, 9, id),
	voided: false,
	itemization: { kind: "itemized", freightCents: 0, taxCents: 0, lines },
	...extra,
});

const cases = (position: number, quantity: number, unitPrice = 24) => ({
	kind: "merchandise" as const,
	position,
	poLineId: 1,
	unmatchedReason: null,
	quantity,
	packSize: 12,
	unitPrice,
	amountCents: Math.round(quantity * unitPrice * 100),
});

describe("cumulative matching", () => {
	test("two partial bills each match what was received", () => {
		const billing = matchBilling(
			[blade(4)],
			[bill(1, [cases(1, 2)]), bill(2, [cases(1, 2)])],
		);
		expect(billing.invoices.get(1)?.kind).toBe("matched");
		expect(billing.invoices.get(2)?.kind).toBe("matched");
		expect(billing.lines).toEqual([
			{ poLineId: 1, sku: "BLADE", receivedItems: 48, matchedItems: 48, billedItems: 48 },
		]);
	});

	test("the later bill is the exception when both ask for the same units", () => {
		const billing = matchBilling(
			[blade(2)],
			[bill(2, [cases(1, 2)]), bill(1, [cases(1, 2)])],
		);
		expect(billing.invoices.get(1)?.kind).toBe("matched");
		expect(billing.invoices.get(2)).toMatchObject({
			kind: "exception",
			discrepancies: [
				{
					kind: "beyond_received",
					billedItems: 24,
					matchedItems: 0,
					receivedItems: 24,
					billedEarlierItems: 24,
				},
			],
		});
		expect(billing.lines[0].matchedItems).toBe(24);
	});

	test("undoing a receipt turns the last bill into an exception", () => {
		const invoices = [bill(1, [cases(1, 2)]), bill(2, [cases(1, 2)])];
		expect(matchBilling([blade(4)], invoices).invoices.get(2)?.kind).toBe(
			"matched",
		);
		const after = matchBilling([blade(3)], invoices);
		expect(after.invoices.get(1)?.kind).toBe("matched");
		expect(after.invoices.get(2)).toMatchObject({
			kind: "exception",
			discrepancies: [{ kind: "beyond_received", matchedItems: 12 }],
		});
	});

	test("a void frees its units and a restored invoice goes to the back", () => {
		const first = bill(1, [cases(1, 2)]);
		const second = bill(2, [cases(1, 2)]);
		const voided = matchBilling([blade(2)], [{ ...first, voided: true }, second]);
		expect(voided.invoices.get(1)?.kind).toBe("void");
		expect(voided.invoices.get(2)?.kind).toBe("matched");
		const restored = matchBilling(
			[blade(2)],
			[{ ...first, activeSince: new Date(2026, 9, 9) }, second],
		);
		expect(restored.invoices.get(2)?.kind).toBe("matched");
		expect(restored.invoices.get(1)?.kind).toBe("exception");
	});

	test("an each-priced bill matches a case-priced line per item", () => {
		const billing = matchBilling(
			[blade(1)],
			[
				bill(1, [
					{ ...cases(1, 12, 2), packSize: 1, amountCents: 2400 },
				]),
			],
		);
		expect(billing.invoices.get(1)?.kind).toBe("matched");
	});

	test("price, missing line, arithmetic, and unpriced lines are exceptions", () => {
		const billing = matchBilling(
			[blade(10), { id: 2, sku: "TAPE", packSize: 1, receivedUnits: 5, prices: [] }],
			[
				bill(1, [
					cases(1, 1, 25),
					{
						kind: "merchandise",
						position: 2,
						poLineId: null,
						unmatchedReason: "not on the PO",
						quantity: 1,
						packSize: 1,
						unitPrice: 3,
						amountCents: 300,
					},
					{ ...cases(3, 1), poLineId: 2, packSize: 1, amountCents: 2500 },
				]),
			],
		);
		const match = billing.invoices.get(1);
		if (match?.kind !== "exception") throw new Error("expected an exception");
		expect(match.discrepancies.map((d) => d.kind)).toEqual([
			"price",
			"not_on_po",
			"line_arithmetic",
			"unpriced_po_line",
		]);
	});

	test("a total that doesn't add up is never matched", () => {
		const billing = matchBilling(
			[blade(2)],
			[bill(1, [cases(1, 2)], { totalCents: 4801 })],
		);
		expect(billing.invoices.get(1)).toMatchObject({
			kind: "exception",
			discrepancies: [{ kind: "total_arithmetic", offCents: 1 }],
		});
	});

	test("headers without lines stay unverified, never matched", () => {
		const billing = matchBilling(
			[blade(2)],
			[
				bill(1, [], { itemization: { kind: "legacy" } }),
				bill(2, [], { itemization: { kind: "header_only" } }),
				bill(3, [cases(1, 2)]),
			],
		);
		expect(billing.invoices.get(1)?.kind).toBe("legacy");
		expect(billing.invoices.get(2)?.kind).toBe("header_only");
		expect(billing.invoices.get(3)?.kind).toBe("matched");
		expect(billing.unverifiedInvoices).toBe(2);
	});
});

describe("payment state", () => {
	const base = {
		totalCents: 10_000,
		voided: false,
		legacy: false,
		openingCents: null,
		appliedCents: 0,
	};

	test("legacy invoices are unknown until history is asserted", () => {
		const unknown = paymentState({ ...base, legacy: true, appliedCents: 2500 });
		expect(unknown).toEqual({ kind: "unknown", totalCents: 10_000, paidHereCents: 2500 });
		expect(openCentsOf(unknown)).toBe(7500);
		expect(paymentState({ ...base, legacy: true, openingCents: 0 }).kind).toBe(
			"unpaid",
		);
		expect(
			paymentState({ ...base, legacy: true, openingCents: 10_000 }).kind,
		).toBe("paid");
	});

	test("recorded invoices start unpaid and track partial payment", () => {
		expect(paymentState(base).kind).toBe("unpaid");
		expect(paymentState({ ...base, appliedCents: 4000 })).toEqual({
			kind: "partial",
			totalCents: 10_000,
			paidCents: 4000,
			openCents: 6000,
		});
		expect(paymentState({ ...base, voided: true, appliedCents: 4000 }).kind).toBe(
			"void",
		);
	});
});

describe("money boundaries", () => {
	test("only whole USD cents get through", () => {
		expect(centsOf(12.34)).toBe(1234);
		expect(() => centsOf(12.345)).toThrow(MoneyError);
		expect(() => centsOf(Number.NaN)).toThrow(MoneyError);
		expect(() => wholeCents(1.5)).toThrow(MoneyError);
		expect(priceUnits(1.2345)).toBe(12_345);
		expect(() => priceUnits(1.23456)).toThrow(MoneyError);
		expect(currencyOf(undefined)).toBe("USD");
		expect(() => currencyOf("CAD")).toThrow(MoneyError);
	});
});
