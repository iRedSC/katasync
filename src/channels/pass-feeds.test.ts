import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import type { Feed } from "#/diagnostics/feed-health";
import { recordFeed } from "#/diagnostics/feed-record";
import type { StorePush } from "#/stock-push/push";
import { createTestDb } from "#/test/db";
import {
	ordersOutcome,
	type PassFeeds,
	readingPassFeeds,
	recordSideFeeds,
} from "./pass-feeds";

const at = new Date("2026-10-10T12:00:00Z");
const push = (over: Partial<StorePush> = {}): StorePush => ({
	store: "Shop",
	changes: [],
	failed: 0,
	excluded: 0,
	problems: [],
	...over,
});
const feeds = (over: Partial<PassFeeds> = {}): PassFeeds => ({
	orders: [],
	listings: [],
	stock: [],
	pushed: [push()],
	retired: [],
	...over,
});

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});

const health = async (feed: Feed, channel: SyncedChannel = "shopify") => {
	const [row] = await db
		.select()
		.from(schema.feedHealth)
		.where(
			and(
				eq(schema.feedHealth.channel, channel),
				eq(schema.feedHealth.feed, feed),
			),
		);
	return row;
};

// What a finished pass records: orders from its own outcome, the rest here.
async function record(f: PassFeeds, startedAt = at) {
	await recordFeed(db, "shopify", "orders", startedAt, ordersOutcome(f));
	await recordSideFeeds(db, "shopify", startedAt, f);
}

describe("a pass's problems land on their own feed", () => {
	test("orders goes ok when only stock and listing problems exist", async () => {
		await record(
			feeds({
				stock: ["A: Shopify refused its stock: nope"],
				listings: ["B: no product matches"],
				pushed: [push({ problems: ["A: Shopify refused its stock: nope"] })],
			}),
		);
		expect(await health("orders")).toMatchObject({ state: "ok" });
		expect(await health("stock")).toMatchObject({
			state: "partial",
			problems: 1,
		});
		expect(await health("listings")).toMatchObject({
			state: "partial",
			detail: "B: no product matches",
		});
	});

	test("an order problem keeps orders partial and nothing else", async () => {
		await record(feeds({ orders: ["#1001: no product for X"] }));
		expect(await health("orders")).toMatchObject({ state: "partial" });
		expect(await health("listings")).toMatchObject({ state: "ok" });
		expect(await health("stock")).toMatchObject({ state: "ok" });
	});

	test("stock skipped by design is counted and keeps the feed ok", async () => {
		await record(feeds({ pushed: [push({ excluded: 722 })] }));
		expect(await health("stock")).toMatchObject({
			state: "ok",
			excluded: 722,
			problems: 0,
		});
	});

	test("a real stock failure makes the feed partial despite exclusions", async () => {
		await record(
			feeds({
				stock: ["A: Shopify refused its stock: nope"],
				pushed: [push({ excluded: 5, problems: ["x"] })],
			}),
		);
		expect(await health("stock")).toMatchObject({
			state: "partial",
			problems: 1,
			excluded: 5,
		});
	});

	test("listings are read only by a pass that asked for them", async () => {
		await record(feeds({ listings: null }));
		expect(await health("listings")).toBeUndefined();
		expect(await health("orders")).toMatchObject({ state: "ok" });
	});

	test("no store pushing means no stock feed", async () => {
		await recordSideFeeds(db, "ebay", at, feeds({ pushed: [] }));
		expect(await health("stock", "ebay")).toBeUndefined();
	});

	test("a stock failure clears only when stock reads again", async () => {
		await recordFeed(db, "shopify", "stock", at, {
			kind: "failed",
			error: "Shopify is down",
		});
		// A later pass that reads orders fine leaves the stock failure alone.
		await recordFeed(
			db,
			"shopify",
			"orders",
			new Date(at.getTime() + 60_000),
			ordersOutcome(feeds()),
		);
		expect(await health("stock")).toMatchObject({ state: "failed" });
		await recordSideFeeds(
			db,
			"shopify",
			new Date(at.getTime() + 120_000),
			feeds({ listings: null }),
		);
		expect(await health("stock")).toMatchObject({ state: "ok" });
	});
});

describe("a pass that throws fails the feed it was reading", () => {
	const pass = (
		listings: boolean,
		work: Parameters<typeof readingPassFeeds>[3],
	) => readingPassFeeds(db, "shopify", { listings }, work);

	test("a listing request throwing fails listings, not orders", async () => {
		await record(feeds());
		expect(await health("listings")).toMatchObject({ state: "ok" });
		await expect(
			pass(true, async (phases) => {
				await phases.listings?.(async () => {
					throw new Error("Shopify answered 502");
				});
				return { feeds: feeds() };
			}),
		).rejects.toThrow("Shopify answered 502");
		expect(await health("listings")).toMatchObject({
			state: "failed",
			detail: "Shopify answered 502",
		});
		// Orders weren't read, so their last record stands.
		expect(await health("orders")).toMatchObject({
			state: "ok",
			attemptedAt: at,
		});
	});

	test("a stock push throwing fails stock", async () => {
		await expect(
			pass(false, async (phases) => {
				await phases.stock(async () => {
					throw new Error("stock lock");
				});
				return { feeds: feeds() };
			}),
		).rejects.toThrow("stock lock");
		expect(await health("stock")).toMatchObject({ state: "failed" });
		expect(await health("orders")).toBeUndefined();
	});

	test("a throw outside every phase fails orders", async () => {
		await expect(
			pass(true, async () => {
				throw new Error("orders 500");
			}),
		).rejects.toThrow("orders 500");
		expect(await health("orders")).toMatchObject({ state: "failed" });
		expect(await health("listings")).toBeUndefined();
	});

	test("a pass that finished records every feed it read", async () => {
		await pass(true, async (phases) => ({
			feeds: feeds({
				listings:
					(await phases.listings?.(async () => ["B: unmatched"])) ?? null,
			}),
		}));
		expect(await health("orders")).toMatchObject({ state: "ok" });
		expect(await health("listings")).toMatchObject({ state: "partial" });
	});
});

describe("retiring refurbs is Shopify's stock", () => {
	const retired = ["Refurb R-1 couldn't be retired: Shopify said no"];

	test("another channel's pass leaves both stock feeds alone", async () => {
		await recordSideFeeds(db, "amazon", at, feeds({ pushed: [], retired }));
		expect(await health("stock", "amazon")).toBeUndefined();
		expect(await health("stock")).toBeUndefined();
	});

	test("nor does it make that channel's stock partial", async () => {
		await recordSideFeeds(db, "amazon", at, feeds({ retired }));
		expect(await health("stock", "amazon")).toMatchObject({ state: "ok" });
	});

	test("Shopify's pass records it, even pushing nothing", async () => {
		await recordSideFeeds(db, "shopify", at, feeds({ pushed: [], retired }));
		expect(await health("stock")).toMatchObject({
			state: "partial",
			detail: retired[0],
		});
		await recordSideFeeds(
			db,
			"shopify",
			new Date(at.getTime() + 60_000),
			feeds({ pushed: [] }),
		);
		expect(await health("stock")).toMatchObject({ state: "ok" });
	});
});
