import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./tiktok", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tiktok")>()),
	shopCipher: vi.fn(async () => "cipher"),
	tiktokApi: vi.fn(),
}));

// The returns pass's lock, always free here.
vi.mock("#/db/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/db/client")>();
	const lockDb = {
		transaction: async (work: (db: Db) => Promise<unknown>) =>
			work({
				execute: async () => ({ rows: [{ locked: true }] }),
			} as unknown as Db),
	} as unknown as Db;
	return {
		...actual,
		withOwnConnection: (work: (db: Db) => Promise<unknown>) => work(lockDb),
	};
});

import type { Db } from "#/db/client";
import { feedHealth, returnRequestRecords } from "#/db/schema";
import { webhookInbox } from "#/db/webhook-schema";
import { CASE, ORDER, RETURN, tiktokCase } from "#/test/tiktok-case";
import { returnsPass } from "./returns-pass";
import { acceptWebhook, drainDue, ingestWith } from "./webhook-inbox";

let t: Awaited<ReturnType<typeof tiktokCase>>;
beforeEach(async () => {
	t = await tiktokCase();
});

test("an aftersales event saves its case with every record and the buyer's photos kept", async () => {
	expect(await t.refresh("aftersales", CASE)).toEqual({ kind: "applied" });
	expect(await t.saved()).toMatchObject({
		externalId: RETURN,
		caseRef: CASE,
		waitingOn: "us",
		note: "Only one came",
		recordsUnread: false,
		sourceVersioned: true,
		sourceUpdatedAt: new Date(1792800000000),
	});
	const records = await t.db
		.select()
		.from(returnRequestRecords)
		.orderBy(returnRequestRecords.position);
	expect(records).toMatchObject([
		{ role: "BUYER", reasonText: "Missing items", note: "Only one came" },
		{ role: "SELLER", note: null, createdAt: new Date(1792600000000) },
	]);
	expect(await t.media()).toEqual([
		expect.objectContaining({ kind: "image", copy: "kept" }),
		expect.objectContaining({ kind: "image", copy: "kept" }),
		expect.objectContaining({
			kind: "video",
			copy: "kept",
			coverUrl: expect.stringContaining("/3~"),
			durationMs: 3000,
		}),
	]);
	expect(t.world.downloads).toHaveLength(3);
});

test("a return event reads its order's cases; an unchanged one isn't read again", async () => {
	await t.refresh("order_returns", ORDER);
	expect(await t.saved()).toMatchObject({ caseRef: CASE });
	const asked = t.api.mock.calls.length;
	await t.refresh("order_returns", ORDER);
	// Search and RMA, but not its records: nothing changed.
	expect(t.api.mock.calls.length).toBe(asked + 2);
});

test("a case TikTok can't show yet, or can't be read, stays in the inbox", async () => {
	expect(await t.refresh("aftersales", "unknown-case")).toEqual({
		kind: "retry",
		error: "TikTok case unknown-case isn't on TikTok's search yet",
	});
	t.api.mockRejectedValue(new Error("TikTok 503"));
	expect(await t.refresh("aftersales", CASE)).toMatchObject({
		kind: "retry",
		error: expect.stringContaining("TikTok 503"),
	});
	expect(await t.saved()).toBeUndefined();
});

test("records that fail leave the case saved and its records unread for the pass", async () => {
	t.world.records = { records: "not a list" };
	expect(await t.refresh("aftersales", CASE)).toEqual({ kind: "applied" });
	expect(await t.saved()).toMatchObject({ caseRef: CASE, recordsUnread: true });
});

// Only the 15-minute pass settles the returns feed.
test("a webhook that reads fine doesn't clear what the pass found wrong", async () => {
	// The pass reads case A, whose records fail: partial.
	t.world.records = { records: "not a list" };
	await returnsPass(t.db, "tiktok", { now: new Date("2026-10-25T12:00:00Z") });
	const [partial] = await t.health();
	expect(partial).toMatchObject({ state: "partial" });
	// Then a webhook reads case B whole.
	t.world.records = { records: [{ role: "BUYER", note: "B" }] };
	t.world.request = {
		...t.world.request,
		return_id: "4035000000000000001",
		update_time: 1792900000,
	};
	expect(await t.refresh("aftersales", CASE)).toEqual({ kind: "applied" });
	expect(await t.health()).toEqual([partial]);
});

test("webhooks failing then succeeding leave a catching-up feed as the pass left it", async () => {
	const attempted = new Date("2026-10-25T11:00:00Z");
	await t.db.insert(feedHealth).values({
		channel: "tiktok",
		feed: "returns",
		state: "catching_up",
		attemptedAt: attempted,
		succeededAt: attempted,
		readThrough: new Date("2026-10-01T00:00:00Z"),
	});
	const before = await t.health();
	const serves = t.api.getMockImplementation();
	t.api.mockRejectedValue(new Error("TikTok 503"));
	expect(await t.refresh("aftersales", CASE)).toMatchObject({ kind: "retry" });
	expect(await t.health()).toEqual(before);
	t.api.mockImplementation(serves ?? (async () => ({})));
	expect(await t.refresh("aftersales", CASE)).toEqual({ kind: "applied" });
	expect(await t.health()).toEqual(before);
});

test("the inbox keeps a case apart from an order with the same id, and drains it", async () => {
	const { db } = t;
	await acceptWebhook(db, "tiktok", { kind: "order", id: CASE }, "a");
	await acceptWebhook(db, "tiktok", { kind: "aftersales", id: CASE }, "b");
	// A repeat delivery is the same work.
	await acceptWebhook(db, "tiktok", { kind: "aftersales", id: CASE }, "b");
	const rows = await db.select().from(webhookInbox);
	expect(rows.map((r) => [r.target, r.generation]).sort()).toEqual([
		["aftersales", 1],
		["order", 1],
	]);
	await expect(
		acceptWebhook(db, "shopify", { kind: "aftersales", id: CASE }, "c"),
	).rejects.toThrow();
	await db.delete(webhookInbox);
	// The real records reader, with nothing to download.
	t.world.records = { records: [{ role: "BUYER", note: "Only one came" }] };
	await acceptWebhook(db, "tiktok", { kind: "aftersales", id: CASE }, "b");
	const drained = await drainDue(db, ingestWith(db));
	expect(await db.select().from(webhookInbox)).toEqual([]);
	expect(drained).toMatchObject({ done: 1 });
	expect(await t.saved()).toMatchObject({ caseRef: CASE });
	expect(await t.health()).toEqual([]);
});
