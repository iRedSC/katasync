import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { returnsWindow } from "#/channels/returns-pass";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	type FeedRecord,
	feedStatus,
	nextRecord,
	STALE_AFTER,
} from "./feed-health";
import { loadFeedRecords, readingFeed, recordFeed } from "./feed-record";

const now = new Date("2026-10-10T12:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const read = (...problems: string[]) => ({ kind: "read" as const, problems });
const failed = (error: string) => ({ kind: "failed" as const, error });

describe("nextRecord", () => {
	test("a failure stands until the same feed reads again", () => {
		const ok = nextRecord(null, minutesAgo(60), read());
		const first = nextRecord(ok, minutesAgo(45), failed("403"));
		const second = nextRecord(first, minutesAgo(30), failed("403 again"));
		expect(second).toMatchObject({
			state: "failed",
			error: "403 again",
			failingSince: minutesAgo(45),
			succeededAt: minutesAgo(60),
		});
		expect(nextRecord(second, minutesAgo(15), read())).toMatchObject({
			state: "ok",
			attemptedAt: minutesAgo(15),
		});
	});

	test("waiting on a report doesn't clear a failure", () => {
		const down = nextRecord(null, minutesAgo(30), failed("FATAL"));
		const waiting = nextRecord(down, minutesAgo(15), { kind: "pending" });
		expect(waiting).toMatchObject({
			state: "failed",
			error: "FATAL",
			failingSince: minutesAgo(30),
			attemptedAt: minutesAgo(15),
		});
	});

	test("a read with problems is partial, and keeps the first", () => {
		expect(
			nextRecord(null, now, read("#1: no product for X", "#2: no stock")),
		).toMatchObject({
			state: "partial",
			problems: 2,
			detail: "#1: no product for X",
		});
	});

	test("an older or repeated attempt is no news", () => {
		const latest = nextRecord(null, minutesAgo(10), failed("down"));
		// A slow pass that started before it, finishing after.
		expect(nextRecord(latest, minutesAgo(20), read())).toBeNull();
		// The same run counted twice.
		expect(nextRecord(latest, minutesAgo(10), read())).toBeNull();
	});

	test("how far a feed has read never moves back", () => {
		const far = nextRecord(null, minutesAgo(30), {
			...read(),
			coveredThrough: minutesAgo(30),
		});
		expect(
			nextRecord(far, minutesAgo(15), {
				...read(),
				coveredThrough: minutesAgo(90),
			})?.coveredThrough,
		).toEqual(minutesAgo(30));
		expect(
			nextRecord(far, minutesAgo(10), failed("down"))?.coveredThrough,
		).toEqual(minutesAgo(30));
	});
});

describe("feedStatus", () => {
	const base = { channel: "ebay" as const, configured: true, now };
	const at = (r: FeedRecord | null, feed: "returns" | "messages" = "returns") =>
		feedStatus({ ...base, feed, record: r });

	test("a channel without the feed, or not connected", () => {
		expect(
			feedStatus({
				...base,
				channel: "shopify",
				feed: "messages",
				record: null,
			}).state,
		).toBe("unsupported");
		expect(
			feedStatus({ ...base, configured: false, feed: "returns", record: null })
				.state,
		).toBe("not_connected");
		expect(at(null).state).toBe("never");
	});

	test("a good read too long ago is stale", () => {
		const fresh = nextRecord(null, minutesAgo(STALE_AFTER.returns - 1), read());
		const old = nextRecord(null, minutesAgo(STALE_AFTER.returns + 1), read());
		expect(at(fresh).state).toBe("ok");
		expect(at(old)).toMatchObject({ state: "stale" });
		// A report pending past that is behind too; a first one isn't yet.
		expect(at(nextRecord(old, minutesAgo(1), { kind: "pending" })).state).toBe(
			"stale",
		);
		expect(at(nextRecord(null, minutesAgo(1), { kind: "pending" })).state).toBe(
			"pending",
		);
	});
});

describe("returnsWindow", () => {
	const reach = { firstDays: 7, rereadDays: 0, spanDays: 30 };
	const DAY = 86_400_000;

	test("resumes a day before the mark, and catches a long outage up in steps", () => {
		expect(returnsWindow(null, now, reach).from).toEqual(
			new Date(now.getTime() - 7 * DAY),
		);
		const recent = returnsWindow(minutesAgo(15), now, reach);
		expect(recent).toEqual({
			from: new Date(minutesAgo(15).getTime() - DAY),
			until: now,
		});
		const outage = returnsWindow(
			new Date(now.getTime() - 45 * DAY),
			now,
			reach,
		);
		expect(outage.from).toEqual(new Date(now.getTime() - 46 * DAY));
		expect(outage.until).toEqual(new Date(now.getTime() - 16 * DAY));
	});

	test("rereads at least rereadDays", () => {
		expect(
			returnsWindow(minutesAgo(15), now, { ...reach, rereadDays: 60 }).from,
		).toEqual(new Date(now.getTime() - 60 * DAY));
	});
});

describe("recording feeds", () => {
	let db: Db;
	beforeEach(async () => {
		db = await createTestDb();
	});

	const row = async () =>
		(
			await db
				.select()
				.from(schema.feedHealth)
				.where(
					and(
						eq(schema.feedHealth.channel, "tiktok"),
						eq(schema.feedHealth.feed, "returns"),
					),
				)
		)[0];

	test("a returns failure isn't cleared by the orders feed", async () => {
		await recordFeed(db, "tiktok", "returns", minutesAgo(20), failed("403"));
		await recordFeed(db, "tiktok", "orders", minutesAgo(10), read());
		const recordFor = await loadFeedRecords(db);
		expect(recordFor("tiktok", "returns")?.state).toBe("failed");
		expect(recordFor("tiktok", "orders")?.state).toBe("ok");
	});

	test("a stale attempt changes nothing", async () => {
		await recordFeed(db, "tiktok", "returns", minutesAgo(10), failed("down"));
		expect(
			await recordFeed(db, "tiktok", "returns", minutesAgo(20), read()),
		).toBeNull();
		expect(await row()).toMatchObject({ state: "failed", detail: "down" });
	});

	test("the table refuses a state with another state's fields", async () => {
		await expect(
			db.insert(schema.feedHealth).values({
				channel: "tiktok",
				feed: "returns",
				state: "ok",
				attemptedAt: now,
				succeededAt: now,
				detail: "403",
			}),
		).rejects.toThrow();
		// Failed without when it began failing.
		await expect(
			db.insert(schema.feedHealth).values({
				channel: "tiktok",
				feed: "returns",
				state: "failed",
				attemptedAt: now,
				detail: "403",
			}),
		).rejects.toThrow();
		// Ok without a success.
		await expect(
			db.insert(schema.feedHealth).values({
				channel: "tiktok",
				feed: "returns",
				state: "ok",
				attemptedAt: now,
			}),
		).rejects.toThrow();
	});

	test("readingFeed records a throw and throws it on", async () => {
		await expect(
			readingFeed(
				db,
				"tiktok",
				"returns",
				async () => {
					throw new Error("TikTok answered 500");
				},
				() => read(),
			),
		).rejects.toThrow(/500/);
		expect(await row()).toMatchObject({
			state: "failed",
			detail: "TikTok answered 500",
		});
	});
});
