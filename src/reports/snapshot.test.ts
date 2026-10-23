import { describe, expect, it } from "vitest";
import { reportChanges } from "./diff";
import { aboutFile, csvFile } from "./files";
import { printHtml } from "./print-html";
import { reportDataFixture } from "./report-data.fixtures";
import {
	canonicalJson,
	contributionFigure,
	orderedReport,
	parseReportData,
} from "./snapshot";

const meta = {
	revision: 2,
	asOf: "2026-10-02T13:14:15.123456Z",
	dataDigest: "a".repeat(64),
};

describe("canonicalJson", () => {
	it("orders every report collection deterministically, including tied rows", () => {
		const base = reportDataFixture();
		const data = {
			...base,
			channels: [
				...base.channels,
				{ ...base.channels[0], source: "amazon" as const },
			],
			jurisdictions: [
				...base.jurisdictions,
				{ ...base.jurisdictions[0], jurisdiction: "Another tax" },
			],
			states: [...base.states, { ...base.states[0], state: "NY" }],
			deposits: [
				...base.deposits,
				{ ...base.deposits[0], externalId: "payout-2", amount: 200 },
			],
			payoutErrors: [
				{ channel: "shopify" as const, error: "one" },
				{ channel: "amazon" as const, error: "two" },
			],
			partial: [
				{ channel: "shopify" as const, firstOrder: "2026-09-01" },
				{ channel: "amazon" as const, firstOrder: "2026-09-01" },
			],
			evidence: [
				...base.evidence,
				{ ...base.evidence[0], soldOn: "amazon" as const },
			],
		};
		const reversed = {
			...data,
			channels: [...data.channels].reverse(),
			jurisdictions: [...data.jurisdictions].reverse(),
			states: [...data.states].reverse(),
			deposits: [...data.deposits].reverse(),
			payoutErrors: [...data.payoutErrors].reverse(),
			partial: [...data.partial].reverse(),
			evidence: [...data.evidence].reverse(),
		};
		const before = orderedReport(data);
		const after = orderedReport(reversed);
		expect(canonicalJson(before)).toBe(canonicalJson(after));
		expect(printHtml(before, meta)).toBe(printHtml(after, meta));
		expect(reportChanges(before, after)).toEqual([]);
	});

	it("doesn't depend on key order, as jsonb doesn't keep it", () => {
		expect(
			canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } }),
		).toBe(canonicalJson({ a: { c: null, d: [2, { x: 0, y: 1 }] }, b: 1 }));
	});

	it("survives a trip through JSON, as a saved revision does", () => {
		const data = reportDataFixture();
		const back = parseReportData(JSON.parse(JSON.stringify(data)));
		expect(canonicalJson(back)).toBe(canonicalJson(data));
	});
});

describe("parseReportData", () => {
	it("refuses a saved revision of another shape", () => {
		expect(() =>
			parseReportData({ ...reportDataFixture(), schemaVersion: 2 }),
		).toThrow(/doesn't read/);
		expect(() =>
			parseReportData({ ...reportDataFixture(), channels: [{ source: "x" }] }),
		).toThrow(/doesn't read/);
	});
});

describe("contributionFigure", () => {
	const base = reportDataFixture().contribution;

	it("is unknown while any order lacks a product or label cost", () => {
		expect(contributionFigure({ ...base, costUnknown: 1 })).toMatchObject({
			kind: "unknown",
			costUnknown: 1,
		});
		expect(contributionFigure({ ...base, labelsMissing: 2 }).kind).toBe(
			"unknown",
		);
	});

	it("says when it rests on estimates", () => {
		expect(contributionFigure({ ...base, feesEstimated: 3 })).toEqual({
			kind: "estimated",
			value: 57.25,
			feesEstimated: 3,
			labelsStandIn: 0,
			labelsAwaiting: 0,
			awaitingReturn: 0,
		});
	});

	it("is complete only when every cost is in", () => {
		expect(contributionFigure(base)).toEqual({
			kind: "complete",
			value: 57.25,
		});
	});
});

describe("files", () => {
	it("keeps overlapping uncertainty categories separate", () => {
		const base = reportDataFixture();
		const data = {
			...base,
			contribution: {
				...base.contribution,
				orders: 1,
				feesEstimated: 1,
				labelsAwaiting: 1,
			},
		};
		const csv = csvFile(data, "contribution");
		expect(csv).toContain("1 estimated fees, 1 labels awaited");
		expect(csv).not.toContain("2 orders");
	});
	it("defuse formulas from marketplace text in exported CSV", () => {
		const deposits = csvFile(reportDataFixture(), "deposits");
		expect(deposits).toContain(`,'=cmd|' /C calc'!A0,`);
		expect(deposits.endsWith("\r\n")).toBe(true);
	});

	it("leave contribution blank, not zero, while a cost is unknown", () => {
		const d = reportDataFixture();
		const unknown = csvFile(
			{ ...d, contribution: { ...d.contribution, costUnknown: 1 } },
			"contribution",
		);
		expect(unknown).toContain(
			'Contribution before overhead,,,"Unknown: 1 orders missing product cost, 0 missing label cost"\r\n',
		);
		expect(csvFile(d, "contribution")).toContain(
			"Contribution before overhead,57.25,,All costs in\r\n",
		);
		expect(csvFile(d, "contribution")).toContain(
			"Cost corrections on goods already sold,-1.25,,\r\n",
		);
	});

	it("keep aged-out fees apart from settled ones", () => {
		const evidence = csvFile(reportDataFixture(), "evidence");
		expect(evidence).toContain(
			'Shopify,"Fees over 60 days old, never settled",1,2.00\r\n',
		);
		expect(evidence).toContain(
			"Shopify,Fees settled by marketplace,0,0.00\r\n",
		);
	});

	it("label proceeds as before product cost", () => {
		expect(csvFile(reportDataFixture(), "sales").split("\r\n")[0]).toContain(
			"Proceeds before product cost",
		);
	});

	it("state currency, time zone, revision and digest", () => {
		const about = aboutFile(reportDataFixture(), meta);
		for (const line of [
			"Currency,USD",
			"Time zone,America/New_York",
			"Revision,2",
			`As of,${meta.asOf}`,
			`Data digest,${meta.dataDigest}`,
		])
			expect(about).toContain(`${line}\r\n`);
	});

	it("render the same bytes from the same figures", () => {
		const d = reportDataFixture();
		expect(printHtml(d, meta)).toBe(
			printHtml(parseReportData(structuredClone(d)), meta),
		);
	});

	it("escape marketplace text in the printable page", () => {
		const html = printHtml(
			reportDataFixture({
				business: { name: "<script>x</script>", homeState: "PA" },
			}),
			meta,
		);
		expect(html).not.toContain("<script>x");
		expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
		expect(html).toContain("Revision 2");
		expect(html).toContain(meta.dataDigest);
	});
});

describe("reportChanges", () => {
	it("keeps distinct payouts with the same date and reference", () => {
		const base = reportDataFixture();
		const payout = { ...base.deposits[0], reference: null };
		const before = {
			...base,
			deposits: [
				{ ...payout, externalId: "first", amount: 100 },
				{ ...payout, externalId: "second", amount: 200 },
			],
		};
		const after = {
			...before,
			deposits: [{ ...before.deposits[0], amount: 900 }, before.deposits[1]],
		};
		expect(reportChanges(before, after)).toEqual([
			expect.objectContaining({
				section: "Deposits",
				field: "amount",
				before: 100,
				after: 900,
			}),
		]);
	});
	it("lists what a later refund changed, and nothing else", () => {
		const before = reportDataFixture();
		const after = reportDataFixture({
			channels: [
				{ ...before.channels[0], refunds: 20, proceedsBeforeCost: 78.5 },
			],
		});
		expect(reportChanges(before, after)).toEqual([
			{
				section: "Sales",
				row: "Online Store",
				field: "refunds",
				before: 0,
				after: 20,
			},
			{
				section: "Sales",
				row: "Online Store",
				field: "proceedsBeforeCost",
				before: 98.5,
				after: 78.5,
			},
		]);
	});

	it("shows rows that appear or go", () => {
		const before = reportDataFixture();
		const changes = reportChanges(before, { ...before, deposits: [] });
		expect(changes.every((c) => c.section === "Deposits")).toBe(true);
		expect(changes.find((c) => c.field === "amount")).toMatchObject({
			before: 90,
			after: undefined,
		});
	});

	it("finds nothing between equal figures", () => {
		expect(reportChanges(reportDataFixture(), reportDataFixture())).toEqual([]);
	});
});
