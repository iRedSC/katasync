import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import { feedStatus } from "#/diagnostics/feed-health";
import { loadFeedRecords, recordFeed } from "#/diagnostics/feed-record";
import type { ReturnRecord } from "#/orders/return-records";
import { type ChannelReturn, returnStage } from "#/orders/return-requests";
import { createTestDb } from "#/test/db";
import { channelPass } from "./channel-pass";
import { backfillReturns } from "./returns-history";
import { returnsPass } from "./returns-pass";
import type { ReturnsReader, ReturnsWindow } from "./returns-readers";
import {
	retryUnreadRecords,
	tiktokReturnsWithRecords,
} from "./tiktok-return-history";
import type { ReadRecords } from "./tiktok-return-records";

const DAY = 86_400_000;
const now = new Date("2026-10-10T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

let db: Db;
let storeId: number;

async function addOrder(externalId: string) {
	await db.insert(schema.orders).values({
		storeId,
		externalId,
		name: externalId,
		placedAt: daysAgo(30),
		fulfillmentStatus: "FULFILLED",
		total: 20,
		sourceUpdatedAt: daysAgo(30),
	});
}

const aReturn = (id: string, order: string, at: Date): ChannelReturn => ({
	externalId: id,
	orderExternalId: order,
	...returnStage("requested", "buyer"),
	amount: null,
	currency: null,
	caseRef: null,
	nextAction: null,
	rawStatus: "OPEN",
	reason: null,
	trackingNumber: null,
	carrier: null,
	requestedAt: at,
	updatedAt: at,
	lines: [],
});

// A marketplace whose search goes by updatedAt, like Shopify's.
function marketplace(
	returns: ChannelReturn[],
	over: Partial<ReturnsReader> = {},
) {
	const asked: ReturnsWindow[] = [];
	const reader: ReturnsReader = {
		firstDays: 7,
		chunkDays: 30,
		rereadsGaps: true,
		read: async (w) => {
			asked.push(w);
			return {
				found: returns.filter(
					(r) => r.updatedAt && r.updatedAt >= w.from && r.updatedAt < w.until,
				),
			};
		},
		...over,
	};
	return { reader, asked };
}

async function status(channel: SyncedChannel, at: Date) {
	const loaded = await loadFeedRecords(db);
	return feedStatus({
		channel,
		feed: "returns",
		configured: true,
		record: loaded.record(channel, "returns"),
		gaps: loaded.gaps(channel, "returns"),
		now: at,
	});
}

async function setUp(channel: SyncedChannel) {
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel, name: channel })
		.returning();
}

describe("a return that can't be saved", () => {
	beforeEach(() => setUp("shopify"));

	test("holds what's verified there, past the overlap, until it saves", async () => {
		const held = aReturn("R1", "O-9", daysAgo(3));
		const { reader, asked } = marketplace([held]);
		await returnsPass(db, "shopify", { now, reader });
		expect(await status("shopify", now)).toMatchObject({
			state: "partial",
			coveredThrough: daysAgo(3),
		});

		// Days later its moment is outside the overlap: it's read on its own.
		const later = new Date(now.getTime() + 30 * 60_000);
		await returnsPass(db, "shopify", { now: later, reader });
		expect(asked.at(-1)?.from).toEqual(new Date(daysAgo(3).getTime() - 1000));
		expect(await status("shopify", later)).toMatchObject({
			state: "partial",
			coveredThrough: daysAgo(3),
		});

		// Its order comes in: the next pass saves it and the hold lifts.
		await addOrder("O-9");
		const after = new Date(later.getTime() + 15 * 60_000);
		await returnsPass(db, "shopify", { now: after, reader });
		expect((await status("shopify", after)).state).toBe("ok");
		expect(await db.select().from(schema.returnRequests)).toHaveLength(1);
	});
});

describe("catching up", () => {
	beforeEach(() => setUp("shopify"));

	test("is never ok, and the next pass resumes where the budget stopped", async () => {
		await recordFeed(db, "shopify", "returns", daysAgo(90), {
			kind: "read",
			problems: [],
			readThrough: daysAgo(90),
		});
		const { reader, asked } = marketplace([]);
		// Each read takes a minute; the budget fits two.
		let clock = 0;
		const timed: ReturnsReader = {
			...reader,
			read: async (w) => {
				clock += 60_000;
				return reader.read(w);
			},
		};
		const run = (at: Date) =>
			returnsPass(db, "shopify", {
				now: at,
				reader: timed,
				clock: () => clock,
				budgetMs: 100_000,
			});
		expect((await run(now)).kind).toBe("catching_up");
		expect(asked).toHaveLength(2);
		expect(await status("shopify", now)).toMatchObject({
			state: "catching_up",
			coveredThrough: daysAgo(31),
		});

		const next = new Date(now.getTime() + 15 * 60_000);
		clock = 0;
		await run(next);
		// From a day before where the first stopped, not from the start again.
		expect(asked[2].from).toEqual(daysAgo(32));
		expect((await status("shopify", next)).state).toBe("ok");
	});
});

describe("Amazon's unreachable days", () => {
	beforeEach(() => setUp("amazon"));

	test("stay a needs-history gap until a history import covers them", async () => {
		const at = new Date();
		await recordFeed(
			db,
			"amazon",
			"returns",
			new Date(at.getTime() - 100 * DAY),
			{
				kind: "read",
				problems: [],
				readThrough: new Date(at.getTime() - 100 * DAY),
			},
		);
		const reader: ReturnsReader = {
			firstDays: 60,
			chunkDays: Number.POSITIVE_INFINITY,
			reachDays: 60,
			rereadsGaps: false,
			read: async (w) => ({ found: [], covered: w }),
		};
		await returnsPass(db, "amazon", { now: at, reader });
		const later = new Date(at.getTime() + 15 * 60_000);
		await returnsPass(db, "amazon", { now: later, reader });
		expect(await status("amazon", later)).toMatchObject({
			state: "needs_history",
		});

		await backfillReturns(
			db,
			"amazon",
			120,
			() => {},
			async () => ({
				returns: [],
				problems: [],
			}),
		);
		const after = new Date(later.getTime() + 15 * 60_000);
		await returnsPass(db, "amazon", { now: after, reader });
		expect((await status("amazon", after)).state).toBe("ok");
	});

	test("a report starting later than asked leaves the rest unread", async () => {
		const reader: ReturnsReader = {
			firstDays: 60,
			chunkDays: Number.POSITIVE_INFINITY,
			reachDays: 60,
			rereadsGaps: false,
			read: async (w) => ({
				found: [],
				covered: { from: daysAgo(30), until: w.until },
			}),
		};
		await returnsPass(db, "amazon", { now, reader });
		expect(await status("amazon", now)).toMatchObject({
			state: "needs_history",
			gaps: [{ from: daysAgo(60), until: daysAgo(30) }],
		});
	});
});

describe("TikTok's return records", () => {
	beforeEach(async () => {
		await setUp("tiktok");
		await addOrder("T-1");
		await addOrder("T-2");
	});

	const said = (note: string): ReturnRecord[] => [
		{
			role: "BUYER",
			event: "ORDER_REFUND",
			description: null,
			reasonText: null,
			note,
			createdAt: null,
			media: [],
		},
	];

	test("records that fail are a problem, saved unread, and asked again", async () => {
		const found = [
			aReturn("A", "T-1", daysAgo(1)),
			aReturn("B", "T-2", daysAgo(1)),
		];
		const read: ReadRecords = async (wanted) => ({
			read: new Map(
				wanted.filter((w) => w.id === "A").map((w) => [w.id, said("Broken")]),
			),
			failed: wanted
				.filter((w) => w.id === "B")
				.map((w) => ({ id: w.id, error: "500" })),
		});
		const { saveReturns } = await import("#/orders/return-requests");
		const store = { id: storeId, channel: "tiktok" as const, name: "TikTok" };
		const first = await tiktokReturnsWithRecords(db, found, read);
		expect(Array.isArray(first) ? [] : first.problems).toEqual([
			expect.stringContaining("B records: 500"),
		]);
		await saveReturns(db, store, Array.isArray(first) ? first : first.returns);
		const saved = async () =>
			Object.fromEntries(
				(await db.select().from(schema.returnRequests)).map((r) => [
					r.externalId,
					{ note: r.note, recordsUnread: r.recordsUnread },
				]),
			);
		expect(await saved()).toEqual({
			A: { note: "Broken", recordsUnread: false },
			B: { note: null, recordsUnread: true },
		});
		expect(await db.select().from(schema.returnRequestRecords)).toHaveLength(1);

		// Unchanged since saved: only the unread one is asked for again.
		const asked: string[][] = [];
		await tiktokReturnsWithRecords(db, found, async (wanted) => {
			asked.push(wanted.map((w) => w.id));
			return { read: new Map(), failed: [] };
		});
		expect(asked).toEqual([["B"]]);

		// And a pass asks for it whatever window it reads.
		expect(
			await retryUnreadRecords(db, async (wanted) => ({
				read: new Map(wanted.map((w) => [w.id, said("Never came")])),
				failed: [],
			})),
		).toEqual([]);
		expect((await saved()).B).toEqual({
			note: "Never came",
			recordsUnread: false,
		});
		expect(await db.select().from(schema.returnRequestRecords)).toHaveLength(2);
	});
});

describe("pnpm sync", () => {
	test("runs the returns pass after orders, even when orders failed", async () => {
		const ran: string[] = [];
		const result = await channelPass(
			{} as Db,
			"ebay",
			{ listings: false, returns: true },
			{
				syncPassAlone: async () => {
					ran.push("orders");
					throw new Error("eBay answered 500");
				},
				returnsPassAlone: async () => {
					ran.push("returns");
					return { kind: "read", problems: [] };
				},
			},
		);
		expect(ran).toEqual(["orders", "returns"]);
		expect(result.ok).toBe(false);
		expect(result.lines.at(-1)).toBe("ebay returns: read");
	});

	test("skips orders a pass or webhook is already writing, through the channel lock", async () => {
		const result = await channelPass(
			{} as Db,
			"shopify",
			{ listings: false, returns: false },
			{
				syncPassAlone: async () => null,
				returnsPassAlone: async () => null,
			},
		);
		expect(result.ok).toBe(true);
		expect(result.lines).toEqual([
			expect.stringMatching(/shopify: another pass or a webhook is running/),
		]);
	});
});
