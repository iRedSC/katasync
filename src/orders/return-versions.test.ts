import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import {
	orders,
	returnRequestRecords,
	returnRequests,
	stores,
} from "#/db/schema";
import { createTestDb } from "#/test/db";
import type { ReturnRecord } from "./return-records";
import {
	type ChannelReturn,
	returnStage,
	saveReturns,
} from "./return-requests";

// Which read wins when two say different things about one return.

let db: Db;
let store: { id: number; channel: "tiktok"; name: string };

beforeEach(async () => {
	db = await createTestDb();
	const [s] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok" })
		.returning();
	store = { id: s.id, channel: "tiktok", name: "TikTok" };
	await db.insert(orders).values({
		storeId: s.id,
		externalId: "O-1",
		name: "O-1",
		placedAt: new Date("2026-10-01T00:00:00Z"),
		fulfillmentStatus: "FULFILLED",
		total: 10,
		sourceUpdatedAt: new Date("2026-10-01T00:00:00Z"),
	});
});

const said = (note: string): ReturnRecord[] => [
	{
		role: "BUYER",
		event: null,
		description: null,
		reasonText: null,
		note,
		createdAt: null,
		media: [],
	},
];

const read = (
	rawStatus: string,
	updatedAt: Date | undefined,
	more: Pick<Partial<ChannelReturn>, "records"> = {},
): ChannelReturn => ({
	externalId: "R-1",
	orderExternalId: "O-1",
	...returnStage("requested", "us"),
	amount: null,
	currency: null,
	caseRef: null,
	nextAction: null,
	rawStatus,
	reason: null,
	trackingNumber: null,
	carrier: null,
	requestedAt: new Date("2026-10-02T00:00:00Z"),
	...(updatedAt && { updatedAt }),
	lines: [],
	...more,
});

const saved = async () => (await db.select().from(returnRequests))[0];
const notes = async () =>
	(await db.select().from(returnRequestRecords)).map((r) => r.note);
const at = (day: number) => new Date(Date.UTC(2026, 9, day));

test("an equal version is news: reads take turns, so a later one is as fresh", async () => {
	await saveReturns(db, store, [read("A", at(5))]);
	await saveReturns(db, store, [read("B", at(5))]);
	expect(await saved()).toMatchObject({ rawStatus: "B" });
});

test("an older version changes nothing", async () => {
	await saveReturns(db, store, [read("NEW", at(6))]);
	await saveReturns(db, store, [read("OLD", at(5), { records: said("old") })]);
	expect(await saved()).toMatchObject({ rawStatus: "NEW" });
	expect(await notes()).toEqual([]);
});

test("a read without a version never replaces one with, and is replaced by one", async () => {
	await saveReturns(db, store, [read("VERSIONED", at(5))]);
	await saveReturns(db, store, [read("UNVERSIONED", undefined)]);
	expect(await saved()).toMatchObject({
		rawStatus: "VERSIONED",
		sourceVersioned: true,
	});

	await db.delete(returnRequests);
	await saveReturns(db, store, [read("UNVERSIONED", undefined)]);
	expect(await saved()).toMatchObject({ sourceVersioned: false });
	await saveReturns(db, store, [read("UNVERSIONED 2", undefined)]);
	expect(await saved()).toMatchObject({ rawStatus: "UNVERSIONED 2" });
	await saveReturns(db, store, [read("VERSIONED", at(5))]);
	expect(await saved()).toMatchObject({
		rawStatus: "VERSIONED",
		sourceVersioned: true,
	});
});

// A save that lands while another read is between looking and writing
// (a history import takes no lock).
function racing(land: () => Promise<unknown>): Db {
	let landed = false;
	return new Proxy(db, {
		get(target, key, receiver) {
			if (key !== "transaction") return Reflect.get(target, key, receiver);
			return async (work: (tx: Db) => Promise<unknown>) => {
				if (!landed) {
					landed = true;
					await land();
				}
				return target.transaction(work);
			};
		},
	});
}

test("records read against an old version don't replace newer ones saved meanwhile", async () => {
	await saveReturns(db, store, [
		read("SAME", at(5), { records: said("first") }),
	]);
	// Same snapshot as saved, so only its records would be written.
	const stale = read("SAME", at(5), { records: said("stale") });
	await saveReturns(
		racing(() =>
			saveReturns(db, store, [
				read("NEWER", at(7), { records: said("newer") }),
			]),
		),
		store,
		[stale],
	);
	expect(await saved()).toMatchObject({ rawStatus: "NEWER" });
	expect(await notes()).toEqual(["newer"]);
});

test("a whole read against an old version doesn't replace a newer save meanwhile", async () => {
	await saveReturns(db, store, [read("FIRST", at(5))]);
	const stale = read("STALE", at(6), { records: said("stale") });
	await saveReturns(
		racing(() =>
			saveReturns(db, store, [
				read("NEWER", at(7), { records: said("newer") }),
			]),
		),
		store,
		[stale],
	);
	expect(await saved()).toMatchObject({ rawStatus: "NEWER" });
	expect(await notes()).toEqual(["newer"]);
});
