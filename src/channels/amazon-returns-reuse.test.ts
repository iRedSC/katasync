import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Report } from "./amazon-reports";

// Which report a returns pass reads: a recent one only when Amazon says it
// covers the start asked for, and what it read is the report's own span.

const reports = vi.hoisted(() => ({
	listed: [] as Report[],
	requested: [] as Record<string, unknown>[],
}));
vi.mock("./amazon-reports", () => ({
	listReports: async () => reports.listed,
	waitForReport: async (id: string) =>
		reports.listed.find((r) => r.reportId === id),
	requestReport: async (_type: string, body: Record<string, unknown>) => {
		reports.requested.push(body);
		return {
			reportId: "new",
			processingStatus: "CANCELLED",
			createdTime: new Date(now),
			dataStartTime: new Date(body.dataStartTime as string),
			dataEndTime: new Date(body.dataEndTime as string),
		};
	},
	reportText: async () => null,
	parseTsv: () => [],
}));

const { recentAmazonReturns } = await import("./amazon-returns");

const now = Date.parse("2026-10-10T12:00:00Z");
const DAY = 86_400_000;
const recent = (start: number): Report => ({
	reportId: "recent",
	processingStatus: "CANCELLED",
	createdTime: new Date(now - 10 * 60_000),
	dataStartTime: new Date(start),
	dataEndTime: new Date(now - 12 * 60_000),
});

describe("recentAmazonReturns", () => {
	beforeEach(() => {
		reports.listed = [];
		reports.requested = [];
	});

	test("reads a recent report that covers the start, through its own end", async () => {
		reports.listed = [recent(now - 60 * DAY)];
		const read = await recentAmazonReturns(new Date(now - 30 * DAY), now);
		expect(reports.requested).toEqual([]);
		expect(read).toMatchObject({
			from: new Date(now - 60 * DAY),
			until: new Date(now - 12 * 60_000),
		});
	});

	test("asks for its own when the recent one starts too late", async () => {
		reports.listed = [recent(now - 5 * DAY)];
		const read = await recentAmazonReturns(new Date(now - 30 * DAY), now);
		expect(reports.requested).toHaveLength(1);
		expect(read).toMatchObject({
			from: new Date(now - 30 * DAY),
			until: new Date(now),
		});
	});
});
