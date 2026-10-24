import { describe, expect, it } from "vitest";
import type { BankCsvMapping } from "#/db/banking-schema";
import { parseBankDate } from "./dates";
import { csvCell, toCsv } from "./export";
import { guessDateFormat, peekFile } from "./guess";
import { type Currency, parseCents, parseCurrency } from "./money";
import { prepareFile } from "./prepare";

const USD = "USD" as Currency;

const signed: BankCsvMapping = {
	date: "Date",
	dateFormat: "mdy",
	description: "Description",
	amount: { kind: "signed", column: "Amount", positiveMeans: "in" },
	bankId: null,
	currency: null,
};

const file = (...lines: string[]) =>
	["Date,Description,Amount", ...lines].join("\n");

function rows(text: string, mapping = signed) {
	const r = prepareFile(text, mapping, USD);
	if (!r.ok) throw new Error(r.problem);
	return r.value.rows;
}

describe("parseCents", () => {
	it.each([
		["12.34", 1234],
		["-12.34", -1234],
		["(1,234.50)", -123450],
		["$1,000", 100000],
		["+5.5", 550],
		["0.07", 7],
	])("reads %s as %i cents", (text, cents) => {
		expect(parseCents(text)).toEqual({ ok: true, value: cents });
	});

	it.each([
		"",
		"12.345",
		"1.234,56",
		"1e5",
		"12,34",
		"--5",
		"+-5",
		"-(5)",
		"(5",
		"abc",
		"99999999999.00",
	])("refuses %s", (text) => {
		expect(parseCents(text).ok).toBe(false);
	});
});

describe("parseCurrency", () => {
	it("takes two-decimal ISO codes, any case", () => {
		expect(parseCurrency(" usd ")).toEqual({ ok: true, value: "USD" });
	});

	it("refuses unknown codes and currencies without cents", () => {
		expect(parseCurrency("XYZ").ok).toBe(false);
		expect(parseCurrency("JPY").ok).toBe(false);
		expect(parseCurrency("US").ok).toBe(false);
	});
});

describe("parseBankDate", () => {
	it("reads the format it's told, not a guess", () => {
		expect(parseBankDate("03/04/2026", "mdy")).toEqual({
			ok: true,
			value: "2026-03-04",
		});
		expect(parseBankDate("03/04/2026", "dmy")).toEqual({
			ok: true,
			value: "2026-04-03",
		});
		expect(parseBankDate("2026-10-23", "ymd")).toEqual({
			ok: true,
			value: "2026-10-23",
		});
	});

	it.each([
		"02/30/2026",
		"13/01/2026",
		"1/2/26",
		"2026-10-23T00:00",
		"",
		"01/01/1850",
	])("refuses %s", (text) => {
		expect(parseBankDate(text, "mdy").ok).toBe(false);
	});
});

describe("prepareFile", () => {
	it("reads quoted cells with commas, quotes, and line breaks", () => {
		const [r] = rows(file('10/01/2026,"Shopify, ""payout""\nline two",125.00'));
		expect(r).toMatchObject({
			kind: "accepted",
			transaction: {
				postedOn: "2026-10-01",
				description: 'Shopify, "payout"\nline two',
				amountCents: 12500,
			},
		});
	});

	it("keeps identical rows without bank IDs, marking the later as a twin", () => {
		const out = rows(file("10/01/2026,Fee,-5.00", "10/01/2026,Fee,-5.00"));
		expect(out.map((r) => r.kind)).toEqual(["accepted", "accepted"]);
		expect(out[1]).toMatchObject({ twinOf: 1 });
	});

	it("refuses a bank ID repeated in the same file", () => {
		const text = [
			"Date,Description,Amount,Id",
			"10/01/2026,A,1,X1",
			"10/02/2026,B,2,X1",
		].join("\n");
		const out = rows(text, { ...signed, bankId: "Id" });
		expect(out[1]).toMatchObject({
			kind: "invalid",
			problem: expect.stringContaining("repeats row 1"),
		});
	});

	it("flips the sign when positive means money out", () => {
		const [r] = rows(file("10/01/2026,Card,40.00"), {
			...signed,
			amount: { kind: "signed", column: "Amount", positiveMeans: "out" },
		});
		expect(r).toMatchObject({ transaction: { amountCents: -4000 } });
	});

	it("reads money in and money out columns, refusing both, neither, or a sign", () => {
		const text = [
			"Date,Description,In,Out",
			"10/01/2026,A,10,",
			"10/01/2026,B,,4",
			"10/01/2026,C,1,1",
			"10/01/2026,D,,",
			"10/01/2026,E,,-4",
		].join("\n");
		const out = rows(text, {
			...signed,
			amount: { kind: "split", moneyIn: "In", moneyOut: "Out" },
		});
		expect(
			out.map((r) =>
				r.kind === "accepted" ? r.transaction.amountCents : r.kind,
			),
		).toEqual([1000, -400, "invalid", "invalid", "invalid"]);
	});

	it("marks bad dates, amounts, zero, and short rows invalid but keeps the rest", () => {
		const out = rows(
			file(
				"13/45/2026,A,1",
				"10/01/2026,B,abc",
				"10/01/2026,C,0",
				"10/01/2026,D",
				"10/01/2026,E,1",
			),
		);
		expect(out.map((r) => r.kind)).toEqual([
			"invalid",
			"invalid",
			"invalid",
			"invalid",
			"accepted",
		]);
	});

	it("refuses rows in another currency", () => {
		const text = [
			"Date,Description,Amount,Ccy",
			"10/01/2026,A,1,USD",
			"10/01/2026,B,1,EUR",
		].join("\n");
		const out = rows(text, { ...signed, currency: "Ccy" });
		expect(out[1]).toMatchObject({
			kind: "invalid",
			problem: expect.stringContaining("conversion"),
		});
	});

	it.each([
		["a missing column", { ...signed, date: "When" }, "no column"],
		[
			"one column for two roles",
			{ ...signed, description: "Amount" },
			"both use",
		],
		[
			"the same column in and out",
			{
				...signed,
				amount: {
					kind: "split" as const,
					moneyIn: "Amount",
					moneyOut: "Amount",
				},
			},
			"both use",
		],
	])("refuses %s", (_, mapping, problem) => {
		const r = prepareFile(file("10/01/2026,A,1"), mapping, USD);
		expect(r).toEqual({ ok: false, problem: expect.stringContaining(problem) });
	});

	it("refuses headers that are blank or repeated, and files that are empty or too big", () => {
		expect(prepareFile("Date,,Amount\n1,2,3", signed, USD).ok).toBe(false);
		expect(prepareFile("Date,date,Amount\n1,2,3", signed, USD).ok).toBe(false);
		expect(prepareFile("Date,Description,Amount\n", signed, USD).ok).toBe(
			false,
		);
		expect(prepareFile("", signed, USD).ok).toBe(false);
		expect(
			prepareFile(file(...Array(10_001).fill("10/01/2026,A,1")), signed, USD)
				.ok,
		).toBe(false);
		expect(
			prepareFile(
				`Date,Description,Amount\n10/01/2026,${"x".repeat(2_000_001)},1`,
				signed,
				USD,
			).ok,
		).toBe(false);
	});

	it("refuses malformed quoting", () => {
		expect(prepareFile(file('10/01/2026,"open,1'), signed, USD).ok).toBe(false);
	});

	it("hashes the exact text, so the same file hashes the same", () => {
		const a = prepareFile(file("10/01/2026,A,1"), signed, USD);
		const b = prepareFile(file("10/01/2026,A,1"), signed, USD);
		const c = prepareFile(`${file("10/01/2026,A,1")}\n`, signed, USD);
		if (!a.ok || !b.ok || !c.ok) throw new Error("unreadable");
		expect(a.value.sha256).toBe(b.value.sha256);
		expect(c.value.sha256).not.toBe(a.value.sha256);
	});
});

describe("peekFile", () => {
	it("guesses a mapping the user then sees and can change", () => {
		const r = peekFile(
			"Posted Date,Payee,Debit,Credit,Reference\n2026-10-01,A,,5,R1",
		);
		expect(r.ok && r.value.guess).toMatchObject({
			date: "Posted Date",
			dateFormat: "ymd",
			description: "Payee",
			amount: { kind: "split", moneyIn: "Credit", moneyOut: "Debit" },
			bankId: "Reference",
		});
		expect(guessDateFormat(["23/10/2026"])).toBe("dmy");
	});
});

describe("export", () => {
	it("defuses formulas and quotes what needs it", () => {
		expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
		expect(csvCell("@sum")).toBe("'@sum");
		expect(csvCell("-1+2")).toBe("'-1+2");
		expect(csvCell(-12.5)).toBe("-12.5");
		expect(toCsv([["a,b", 'say "hi"', null]])).toBe('"a,b","say ""hi""",\r\n');
		expect(csvCell("  =1+1")).toBe("'  =1+1");
	});
});
