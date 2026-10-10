import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	channelHealth,
	groupIssues,
	hintFor,
	type Run,
	workerAlive,
} from "./health";
import { diagnosticsOverview } from "./overview";
import { MAX_ISSUES_PER_RUN, recordSyncRun, splitProblem } from "./runs";

const now = new Date("2026-10-10T12:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const run = (ago: number, extra: Partial<Run> = {}): Run => ({
	startedAt: minutesAgo(ago),
	finishedAt: minutesAgo(ago - 1),
	problems: 0,
	error: null,
	...extra,
});

describe("channelHealth", () => {
	const base = { configured: true, now };

	test("healthy, degraded, and never synced", () => {
		expect(
			channelHealth({ ...base, runs: [run(3)], lastSuccessAt: minutesAgo(2) })
				.health,
		).toBe("healthy");
		expect(
			channelHealth({
				...base,
				runs: [run(3, { problems: 4 })],
				lastSuccessAt: minutesAgo(2),
			}).health,
		).toBe("degraded");
		expect(
			channelHealth({ ...base, runs: [], lastSuccessAt: null }).health,
		).toBe("never_synced");
		expect(
			channelHealth({ configured: false, now, runs: [], lastSuccessAt: null })
				.health,
		).toBe("not_connected");
	});

	test("failing says since when, and ignores a run still going", () => {
		const s = channelHealth({
			...base,
			runs: [
				{ ...run(1), finishedAt: null },
				run(3, { error: "eBay answered 500" }),
				run(5, { error: "eBay answered 500" }),
				run(7),
			],
			lastSuccessAt: minutesAgo(6),
		});
		expect(s).toMatchObject({
			health: "failing",
			consecutiveFailures: 2,
			failingSince: minutesAgo(5),
			latestError: "eBay answered 500",
		});
	});

	test("stale when the last good pass is old, even without errors", () => {
		expect(
			channelHealth({ ...base, runs: [run(40)], lastSuccessAt: minutesAgo(39) })
				.health,
		).toBe("stale");
	});

	test("the worker is alive while passes keep starting", () => {
		expect(workerAlive(minutesAgo(3), now)).toBe(true);
		expect(workerAlive(minutesAgo(11), now)).toBe(false);
		expect(workerAlive(null, now)).toBe(false);
	});
});

test("hints for known failures", () => {
	expect(
		hintFor("ebay", 'eBay login failed: 400 {"error":"invalid_grant"}')?.action,
	).toMatch(/quoted/);
	expect(hintFor("shopify", "Set SHOPIFY_ADMIN_TOKEN")?.action).toMatch(
		/SHOPIFY_ADMIN_TOKEN/,
	);
	expect(hintFor("shopify", "Shopify error: ACCESS_DENIED")?.action).toMatch(
		/Develop apps/,
	);
	expect(hintFor("amazon", "TypeError: fetch failed")?.title).toMatch(/reach/);
	expect(hintFor("amazon", "something new")).toBeNull();
});

test("problems split into order and message, and group by message", () => {
	expect(splitProblem("#5536: no product for KNIFE-5")).toEqual({
		reference: "#5536",
		message: "no product for KNIFE-5",
	});
	expect(splitProblem("odd")).toEqual({ reference: null, message: "odd" });
	expect(
		groupIssues([
			{ reference: "#1", message: "no product for A" },
			{ reference: "#2", message: "no product for B" },
			{ reference: "#3", message: "no product for B" },
		]),
	).toEqual([
		{ message: "no product for B", count: 2, references: ["#2", "#3"] },
		{ message: "no product for A", count: 1, references: ["#1"] },
	]);
});

describe("recording runs", () => {
	let db: Db;
	beforeEach(async () => {
		db = await createTestDb();
	});

	test("records a pass, caps its issue rows, and keeps the exact count", async () => {
		const problems = Array.from(
			{ length: MAX_ISSUES_PER_RUN + 5 },
			(_, i) => `#${i}: no product for X`,
		);
		await recordSyncRun(
			db,
			"ebay",
			async () => ({ store: "eBay US", orders: 3, problems }),
			() => now,
		);
		const [saved] = await db.select().from(schema.syncRuns);
		expect(saved).toMatchObject({
			channel: "ebay",
			orders: 3,
			problems: MAX_ISSUES_PER_RUN + 5,
			error: null,
			finishedAt: now,
		});
		expect(await db.select().from(schema.syncIssues)).toHaveLength(
			MAX_ISSUES_PER_RUN,
		);
	});

	test("records a failure and throws it on", async () => {
		await expect(
			recordSyncRun(
				db,
				"amazon",
				async () => {
					throw new Error("Amazon login failed: 400\n    at accessToken");
				},
				() => now,
			),
		).rejects.toThrow(/login failed/);
		const [saved] = await db.select().from(schema.syncRuns);
		expect(saved.error).toBe("Amazon login failed: 400");
	});

	test("the overview reads failing channels and their hint", async () => {
		process.env.EBAY_CLIENT_ID = "id";
		process.env.EBAY_CLIENT_SECRET = "secret";
		process.env.EBAY_REFRESH_TOKEN = "v^1.1#i^1#r^1";
		try {
			await recordSyncRun(
				db,
				"ebay",
				async () => ({ store: "eBay US", orders: 1, problems: [] }),
				() => minutesAgo(5),
			);
			await recordSyncRun(
				db,
				"ebay",
				async () => {
					throw new Error("eBay login failed: 400 invalid_grant");
				},
				() => minutesAgo(2),
			).catch(() => {});
			const o = await diagnosticsOverview(db, now);
			const ebay = o.channels.find((c) => c.channel === "ebay");
			expect(ebay).toMatchObject({
				health: "failing",
				consecutiveFailures: 1,
				lastSuccessAt: minutesAgo(5),
			});
			expect(ebay?.hint?.title).toMatch(/eBay refused/);
			expect(o.worker.alive).toBe(true);
		} finally {
			delete process.env.EBAY_CLIENT_ID;
			delete process.env.EBAY_CLIENT_SECRET;
			delete process.env.EBAY_REFRESH_TOKEN;
		}
	});
});
