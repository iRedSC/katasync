import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./tiktok", () => ({
	shopCipher: vi.fn(async () => "cipher"),
	tiktokApi: vi.fn(),
}));

import { eq } from "drizzle-orm";
import { orders, returnRequests } from "#/db/schema";
import { orderRecords, type ReturnRecord } from "#/orders/return-records";
import { CASE, jpeg, photo, tiktokCase } from "#/test/tiktok-case";
import { retryUnreadRecords } from "./tiktok-return-history";
import { type ReadRecords, recordsOutcome } from "./tiktok-return-records";

// What happens to a buyer's photo when TikTok won't hand it over.

let t: Awaited<ReturnType<typeof tiktokCase>>;
beforeEach(async () => {
	t = await tiktokCase();
});

const copies = async () =>
	(await t.media()).map((m) => [m.copy, m.failedFetches]);

test("a refused download is asked again with a fresh link, and gone only after three", async () => {
	// TikTok answers 403 for photo 2's link every time.
	t.world.serve = (url) => (url.includes("/2~") ? { kind: "failed" } : jpeg());
	for (const tries of [1, 2]) {
		await t.refresh("aftersales", CASE);
		expect(await copies()).toEqual([
			["kept", 0],
			["unfetched", tries],
			["kept", 0],
		]);
		expect(await t.saved()).toMatchObject({ recordsUnread: true });
	}
	t.world.downloads = [];
	await t.refresh("aftersales", CASE);
	// Only the missing one asked for, on its fresh link.
	expect(t.world.downloads).toEqual([expect.stringContaining("/2~")]);
	expect(await copies()).toEqual([
		["kept", 0],
		["gone", 3],
		["kept", 0],
	]);
	expect(await t.saved()).toMatchObject({ recordsUnread: false });
	// Gone isn't asked for again.
	t.world.downloads = [];
	t.world.request = { ...t.world.request, update_time: 1792900000 };
	await t.refresh("aftersales", CASE);
	expect(t.world.downloads).toEqual([]);
});

test("a photo that downloads on a later try is kept, the others carried over", async () => {
	t.world.serve = (url) => (url.includes("/2~") ? { kind: "failed" } : jpeg());
	await t.refresh("aftersales", CASE);
	t.world.serve = () => jpeg("later");
	t.world.downloads = [];
	await t.refresh("aftersales", CASE);
	expect(t.world.downloads).toHaveLength(1);
	expect((await t.media()).map((m) => m.data?.toString())).toEqual([
		"jpeg",
		"later",
		"jpeg",
	]);
	expect(await t.saved()).toMatchObject({ recordsUnread: false });
});

test("a 404 is gone at once", async () => {
	t.world.serve = (url) => (url.includes("/1~") ? { kind: "missing" } : jpeg());
	await t.refresh("aftersales", CASE);
	expect((await copies())[0]).toEqual(["gone", 1]);
	expect(await t.saved()).toMatchObject({ recordsUnread: false });
});

test("a link off TikTok's media hosts is refused, said, and never fetched", async () => {
	t.world.serve = (url) => (url.includes("/1~") ? { kind: "refused" } : jpeg());
	await t.refresh("aftersales", CASE);
	expect((await copies())[0]).toEqual(["refused", 0]);
	expect(await t.saved()).toMatchObject({ recordsUnread: false });
	const outcome = recordsOutcome("R", {
		records: [
			{
				role: "BUYER",
				event: null,
				description: null,
				reasonText: null,
				note: null,
				createdAt: null,
				media: [
					{
						kind: "image",
						url: "https://evil.example/x.jpeg",
						sourceKey: "/x.jpeg",
						width: null,
						height: null,
						copy: "refused",
					},
				],
			},
		],
	});
	expect(outcome.problems).toEqual([
		expect.stringContaining("aren't on TikTok's media hosts"),
	]);
});

test("a backlog of unread records works through over passes, oldest asked first", async () => {
	const [order] = await t.db.select().from(orders);
	await t.db.insert(returnRequests).values(
		["R1", "R2", "R3"].map((externalId) => ({
			orderId: order.id,
			billedBy: "tiktok" as const,
			externalId,
			status: "requested" as const,
			waitingOn: "us" as const,
			rawStatus: "OPEN",
			requestedAt: new Date("2026-10-01T00:00:00Z"),
			sourceUpdatedAt: new Date("2026-10-01T00:00:00Z"),
			sourceVersioned: true,
			recordsUnread: true,
		})),
	);
	const asked: string[][] = [];
	// R1 keeps failing; the rest read.
	const read: ReadRecords = async (wanted, until) => {
		asked.push(wanted.map((w) => w.id));
		if (until !== undefined && until <= Date.now())
			return { read: new Map(), failed: [] };
		return {
			read: new Map(
				wanted
					.filter((w) => w.id !== "R1")
					.map((w) => [w.id, [] as ReturnRecord[]]),
			),
			failed: wanted
				.filter((w) => w.id === "R1")
				.map((w) => ({ id: w.id, error: "500" })),
		};
	};
	// Out of budget: nothing started, nothing marked asked.
	expect(await retryUnreadRecords(t.db, read, Date.now() - 1)).toEqual([]);
	const unread = async () =>
		(await t.db.select().from(returnRequests))
			.filter((r) => r.recordsUnread)
			.map((r) => [r.externalId, r.recordsAskedAt !== null])
			.sort();
	expect(await unread()).toEqual([
		["R1", false],
		["R2", false],
		["R3", false],
	]);
	await retryUnreadRecords(t.db, read);
	expect(await unread()).toEqual([["R1", true]]);
	// One never asked goes ahead of the one that keeps failing.
	await t.db
		.update(returnRequests)
		.set({ recordsUnread: true, recordsAskedAt: null })
		.where(eq(returnRequests.externalId, "R3"));
	await retryUnreadRecords(t.db, read);
	expect(asked.at(-1)).toEqual(["R3", "R1"]);
});

type Records = {
	records: {
		images?: { url: string }[];
		videos?: { url: string; cover?: string }[];
	}[];
};

test("a photo a later read leaves out keeps its copy, on no record", async () => {
	await t.refresh("aftersales", CASE);
	const before = await t.media();
	expect(before.map((m) => m.copy)).toEqual(["kept", "kept", "kept"]);
	// TikTok's next read shows only photo 2, and drops the seller's record.
	const records = t.world.records as Records;
	t.world.records = {
		records: [
			{ ...records.records[0], images: [{ url: photo(2) }], videos: [] },
		],
	};
	t.world.request = { ...t.world.request, update_time: 1792900000 };
	await t.refresh("aftersales", CASE);
	const after = await t.media();
	expect(after).toHaveLength(3);
	expect(after.every((m) => m.copy === "kept" && m.data !== null)).toBe(true);
	expect(after.filter((m) => m.recordId === null)).toHaveLength(2);
	const [order] = await t.db.select().from(orders);
	const [shown] = [...(await orderRecords(t.db, order.id)).values()];
	expect(shown.records).toHaveLength(1);
	expect(shown.records[0].media).toHaveLength(1);
	expect(shown.unlisted.map((m) => m.copy)).toEqual(["kept", "kept"]);
	// Shown again, it's back on its record, still the same copy.
	t.world.records = records;
	t.world.request = { ...t.world.request, update_time: 1792950000 };
	t.world.downloads = [];
	await t.refresh("aftersales", CASE);
	expect(t.world.downloads).toEqual([]);
	expect((await t.media()).every((m) => m.recordId !== null)).toBe(true);
});

test("a video's own link is kept only on TikTok's media hosts, whatever its cover", async () => {
	const records = t.world.records as Records;
	const video = (url: string) => ({
		records: [{ ...records.records[0], videos: [{ url, cover: photo(3) }] }],
	});
	// The fixture's video is off TikTok's hosts; its cover is on them.
	t.world.records = video("https://evil.example/v.mp4");
	await t.refresh("aftersales", CASE);
	const off = (await t.media()).find((m) => m.kind === "video");
	expect(off).toMatchObject({ url: null, copy: "kept" });
	expect((await t.saved()).recordsUnread).toBe(false);
	const tiktok = "https://v16m.tiktokcdn-us.com/1e26/video/v";
	t.world.records = video(tiktok);
	t.world.request = { ...t.world.request, update_time: 1792900000 };
	await t.refresh("aftersales", CASE);
	expect((await t.media()).find((m) => m.kind === "video")).toMatchObject({
		url: tiktok,
		copy: "kept",
	});
});
