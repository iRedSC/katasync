import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { missingToAsk, settleMissing } from "./tiktok-missing";

let db: Db;
let store: number;
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));

beforeEach(async () => {
	db = await createTestDb();
	[{ id: store }] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok Shop" })
		.returning({ id: stores.id });
});

test("an order TikTok left out is asked for again, whatever the cursor did", async () => {
	expect(
		await settleMissing(db, store, ["1", "2"], new Set(["1"]), day(10)),
	).toEqual({ missing: ["2"], gaveUp: [] });
	expect(await missingToAsk(db, store)).toEqual(["2"]);
	// Missed again, still inside the hold.
	expect(await settleMissing(db, store, ["2"], new Set(), day(12))).toEqual({
		missing: ["2"],
		gaveUp: [],
	});
	// Answered: no longer asked for.
	await settleMissing(db, store, ["2", "3"], new Set(["2", "3"]), day(12));
	expect(await missingToAsk(db, store)).toEqual([]);
});

test("one TikTok never returns is given up on after the hold", async () => {
	await settleMissing(db, store, ["9"], new Set(), day(10));
	expect(await settleMissing(db, store, ["9"], new Set(), day(14))).toEqual({
		missing: [],
		gaveUp: ["9"],
	});
	expect(await missingToAsk(db, store)).toEqual([]);
});
