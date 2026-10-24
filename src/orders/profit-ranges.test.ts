import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { daysOf, RANGES, type RangeKey, today } from "#/lib/period";
import { resolvePeriod, resolveRange } from "./profit";
import { profitFixture } from "./profit.fixtures";

let db: Db;

beforeEach(async () => {
	({ db } = await profitFixture());
});

describe("ranges", () => {
	// Friday 8 AM in New York.
	const friday = new Date("2026-10-16T12:00:00Z");

	test("weeks start on Saturday, in the shop's time", async () => {
		expect(await resolveRange(db, "this_week", friday)).toEqual({
			start: new Date("2026-10-10T04:00:00Z"),
			end: friday,
			previousStart: new Date("2026-10-03T04:00:00Z"),
			previousEnd: new Date("2026-10-09T12:00:00Z"),
		});
		// Saturday itself starts a new week.
		const saturday = new Date("2026-10-17T13:00:00Z");
		expect((await resolveRange(db, "this_week", saturday)).start).toEqual(
			new Date("2026-10-17T04:00:00Z"),
		);
		expect((await resolveRange(db, "last_week", saturday)).end).toEqual(
			new Date("2026-10-17T04:00:00Z"),
		);
	});

	test("a month so far compares with last month to the same day", async () => {
		expect(await resolveRange(db, "this_month", friday)).toEqual({
			start: new Date("2026-10-01T04:00:00Z"),
			end: friday,
			previousStart: new Date("2026-09-01T04:00:00Z"),
			previousEnd: new Date("2026-09-16T12:00:00Z"),
		});
		// Late at night in New York is already tomorrow in UTC.
		const lateNight = new Date("2026-11-01T03:30:00Z");
		expect((await resolveRange(db, "this_month", lateNight)).start).toEqual(
			new Date("2026-10-01T04:00:00Z"),
		);
	});

	// The search filters lists by named ranges in the browser (lib/period.ts)
	// and the server resolves them here; they must agree on the days.
	test("named ranges cover the days the search filters by", async () => {
		for (const now of [friday, new Date("2026-11-01T03:30:00Z")]) {
			for (const key of Object.keys(RANGES) as RangeKey[]) {
				const { from, to } = daysOf({ kind: "range", key }, today(now));
				const sql = await resolvePeriod(db, { kind: "days", from, to }, now);
				const named = await resolveRange(db, key, now);
				expect(named.start, key).toEqual(sql.start);
				// Ranges still running end now, the rest at the next midnight.
				expect([sql.end, now], key).toContainEqual(named.end);
			}
		}
	});

	test("open ends reach back past every order, and up to now", async () => {
		const open = await resolvePeriod(
			db,
			{ kind: "days", from: null, to: null },
			friday,
		);
		expect(open.start.getTime()).toBe(0);
		expect(open.end).toEqual(friday);
	});
});
