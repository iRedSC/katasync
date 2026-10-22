import { describe, expect, it } from "vitest";
import { payoutTotals, shopDay, shopDayLabel } from "./sales-report";

describe("shopDay", () => {
	it("gives the shop's day, not UTC's, past midnight UTC", () => {
		// 9:00 PM Eastern on September 30, daylight time.
		expect(shopDay(new Date("2026-10-01T01:00:00Z"))).toBe("2026-09-30");
		expect(shopDayLabel(new Date("2026-10-01T01:00:00Z"))).toBe("Sep 30");
	});

	it("follows the offset change at the end of daylight time", () => {
		// 11:30 PM Eastern on October 31, still daylight time.
		expect(shopDay(new Date("2026-11-01T03:30:00Z"))).toBe("2026-10-31");
		// 1:30 AM Eastern on November 1, standard time.
		expect(shopDay(new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01");
	});
});

describe("payoutTotals", () => {
	it("keeps sent and pending apart and leaves failed out", () => {
		expect(
			payoutTotals([
				{ status: "sent", amount: 40 },
				{ status: "pending", amount: 60 },
				{ status: "failed", amount: 25 },
			]),
		).toEqual({ sent: 40, pending: 60 });
	});

	it("counts a negative sent payout as money taken back", () => {
		expect(
			payoutTotals([
				{ status: "sent", amount: 100 },
				{ status: "sent", amount: -15 },
			]),
		).toEqual({ sent: 85, pending: 0 });
	});
});
