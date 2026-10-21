import { describe, expect, test } from "vitest";
import report from "./amazon-performance.fixture.json";
import { ebayRead } from "./ebay-standing";
import {
	amazonStanding,
	type Standing,
	shopifyStanding,
	standing,
} from "./standing";
import { tiktokProblems, tiktokVerdict } from "./tiktok-standing";

// A real GET_V2_SELLER_PERFORMANCE_REPORT, trimmed to the parts read.
const US = "ATVPDKIKX0DER";
const copy = () => structuredClone(report) as typeof report;
const summary = (s: Standing) =>
	s.verdict.state === "read" ? s.verdict.summary : s.verdict.state;

describe("Amazon", () => {
	test("reads health, metrics against limits, and policy problems", () => {
		const s = amazonStanding(report, US);
		expect(summary(s)).toBe("Account health great (264)");
		expect(s.metrics.map((m) => m.label)).toEqual([
			"Order defect rate",
			"Order defect rate (FBA)",
			"Late shipments",
			"Cancellations",
			"Valid tracking",
			"On-time delivery",
		]);
		expect(s.metrics[2]).toEqual({
			label: "Late shipments",
			value: { kind: "rate", rate: 0, count: 0, of: 639 },
			target: { kind: "below", value: 0.04 },
			level: "good",
			window: { from: "2026-09-22", to: "2026-10-21" },
		});
		expect(s.metrics[4].target).toEqual({ kind: "above", value: 0.95 });
		// Two listing violations Amazon marks BAD: the account is at risk
		// even though every rate is fine.
		expect(s.problems).toEqual([
			{
				level: "at_risk",
				text: "2 listing policy violations",
				href: expect.stringContaining("sellercentral"),
				detail: expect.stringContaining("Account Health"),
				items: [],
			},
		]);
		expect(s.level).toBe("at_risk");
	});

	test("an account Amazon marks at risk says so first", () => {
		const r = copy();
		r.accountStatuses[0].status = "AT_RISK";
		const s = amazonStanding(r, US);
		expect(summary(s)).toBe("Account at risk");
		expect(s.problems[0].text).toBe("Account at risk");
	});

	test("a status Amazon hasn't documented is worth a look, not fine", () => {
		const r = copy();
		r.performanceMetrics[0].listingPolicyViolations.defectsCount = 0;
		r.performanceMetrics[0].lateShipmentRate.status = "SOMETHING_NEW";
		const s = amazonStanding(r, US);
		expect(s.metrics[2].level).toBe("watch");
		expect(s.level).toBe("watch");
	});

	test("a report without our marketplace fails loudly", () => {
		expect(() => amazonStanding(report, "A2EUQ1WTGCTBG2")).toThrow(
			"no A2EUQ1WTGCTBG2",
		);
	});
});

describe("Shopify", () => {
	test("a chargeback waiting on us puts the account at risk", () => {
		const s = shopifyStanding(
			[
				{
					orderName: "#1",
					href: "x/1",
					status: "NEEDS_RESPONSE",
					initiatedAs: "CHARGEBACK",
					total: "$120.00",
					placedAt: "2026-10-01T12:00:00Z",
				},
				{
					orderName: "#2",
					href: "x/2",
					status: "UNDER_REVIEW",
					initiatedAs: "INQUIRY",
					total: "$40.00",
					placedAt: "2026-10-02T12:00:00Z",
				},
			],
			0,
		);
		expect(s.level).toBe("at_risk");
		expect(summary(s)).toBe("2 open disputes");
		expect(s.problems).toMatchObject([
			{
				level: "at_risk",
				text: "Chargeback on #1 needs a response",
				detail: expect.stringMatching(/^\$120\.00 order placed 2026-10-01\./),
			},
			{ level: "watch", text: "Inquiry on #2 under review" },
		]);
	});

	test("none open is good", () => {
		const s = shopifyStanding([], 0);
		expect(s.level).toBe("good");
		expect(summary(s)).toBe("No open disputes");
	});
});

describe("eBay", () => {
	// Shapes from eBay's Analytics docs; the token can't read them yet.
	const profile = {
		standardsLevel: "ABOVE_STANDARD",
		program: "PROGRAM_US",
		metrics: [
			{ metricKey: "MIN_TXN_COUNT", name: "Transactions", level: "TOP_RATED" },
			{
				metricKey: "SHIPPING_MISS_RATE",
				name: "Late shipment rate",
				level: "BELOW_STANDARD",
			},
		],
	};
	const service = (rating: string) => ({
		dimensionMetrics: [
			{
				metrics: [
					{ metricKey: "RATE", value: "0.78", benchmark: { rating } },
					{ metricKey: "COUNT", value: "3" },
				],
			},
		],
	});

	test("seller level, metrics below standard, and complaint ratings", () => {
		const s = ebayRead(profile, {
			ITEM_NOT_RECEIVED: service("AVERAGE"),
			ITEM_NOT_AS_DESCRIBED: service("VERY_HIGH"),
		});
		expect(summary(s)).toBe("Above standard");
		expect(s.problems).toMatchObject([
			{ level: "at_risk", text: "Late shipment rate below standard" },
		]);
		expect(s.metrics).toMatchObject([
			{ label: "Item not received", level: "good" },
			{
				label: "Not as described",
				level: "at_risk",
				value: { kind: "rating", text: "Very high next to similar sellers" },
			},
		]);
		expect(s.level).toBe("at_risk");
	});

	test("a rating eBay didn't give is left out, not shown as fine", () => {
		const s = ebayRead(
			{ standardsLevel: "TOP_RATED" },
			{ ITEM_NOT_RECEIVED: null },
		);
		expect(s).toMatchObject({ level: "good", metrics: [] });
		expect(summary(s)).toBe("Top rated");
	});
});

describe("TikTok", () => {
	test("reads the shop performance tier", () => {
		expect(
			tiktokVerdict([
				{ sps_score: "4.5", sps_tier: "Good", last_updated_date: "2026-06-22" },
			]),
		).toEqual({
			state: "read",
			level: "good",
			summary: "Shop performance Good (4.5)",
		});
		expect(tiktokVerdict({ sps_tier: "Something new" })).toMatchObject({
			level: "watch",
		});
	});

	// As TikTok's product detail answers for a product that failed review.
	const failed = (id: string, sku: string) => ({
		status: "FAILED" as const,
		id,
		title: `Product ${id}`,
		skuId: `sku-${id}`,
		sellerSku: sku,
		detail: {
			audit_failed_reasons: [
				{
					position: "Variation",
					reasons: ["Abnormally Low Pricing"],
					suggestions: [
						"Prices are too low.<br><br>\nAdjust them and re-submit.",
					],
				},
			],
		},
	});

	test("groups stopped products by reason, with TikTok's suggestion", () => {
		const problems = tiktokProblems([
			failed("1", "COL-BH26"),
			failed("2", "COL-FA280"),
			{
				status: "FREEZE",
				id: "3",
				title: "Frozen one",
				skuId: "sku-3",
				sellerSku: null,
				detail: {},
			},
		]);
		expect(problems).toEqual([
			{
				level: "watch",
				text: "Failed review: Abnormally Low Pricing",
				href: expect.any(String),
				detail: "Prices are too low. Adjust them and re-submit.",
				items: [
					expect.objectContaining({
						listingId: "sku-1",
						ref: "COL-BH26",
						detail: "In variation",
					}),
					expect.objectContaining({ listingId: "sku-2", ref: "COL-FA280" }),
				],
			},
			expect.objectContaining({
				level: "at_risk",
				text: "Frozen: No reason given",
				items: [expect.objectContaining({ ref: "3" })],
			}),
		]);
	});

	test("without its verdict, its problems still set the level", () => {
		const fix = { state: "needs_access" as const, fix: "Sign in" };
		expect(standing(fix, [], []).level).toBeNull();
		expect(standing(fix, [], tiktokProblems([failed("1", "A")])).level).toBe(
			"watch",
		);
	});
});
