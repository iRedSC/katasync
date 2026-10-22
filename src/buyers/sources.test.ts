import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { buyerMessageChecks, mailboxChecks } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { messageSources } from "./threads";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});

const min = 60_000;

test("a quiet mailbox isn't behind until its sweep is late", async () => {
	const now = Date.now();
	await db.insert(buyerMessageChecks).values([
		{ market: "amazon", checkedAt: new Date(now - 4 * min) },
		{ market: "ebay", checkedAt: new Date(now - 30 * min) },
	]);
	await db.insert(mailboxChecks).values({
		mailbox: "marketplaces",
		checkedAt: new Date(now - 3 * 60 * min),
	});
	const [amazon, ebay] = await messageSources(db, now);
	expect(amazon?.behind).toBe(false);
	expect(ebay?.behind).toBe(true);
	const later = now + 2 * 60 * min;
	await db.update(buyerMessageChecks).set({ checkedAt: new Date(later - min) });
	expect((await messageSources(db, later))[0]?.behind).toBe(true);
});
