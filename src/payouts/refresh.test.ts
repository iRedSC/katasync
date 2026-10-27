import { eq } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { payouts } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { refreshPayouts, refreshSince } from "./refresh";
import { fetchShopifyPayouts } from "./shopify";
import type { FetchedPayout } from "./types";

// The payout lock as Postgres would keep it: one holder at a time, let go
// when its transaction ends.
let held = false;
vi.mock("#/db/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/db/client")>();
	const lockDb = {
		transaction: async (work: (db: Db) => Promise<unknown>) => {
			let mine = false;
			try {
				return await work({
					execute: async () => {
						if (!mine && !held) held = mine = true;
						return { rows: [{ locked: mine }] };
					},
				} as unknown as Db);
			} finally {
				if (mine) held = false;
			}
		},
	} as unknown as Db;
	return {
		...actual,
		withOwnConnection: (work: (db: Db) => Promise<unknown>) => work(lockDb),
	};
});
vi.mock("./shopify", () => ({ fetchShopifyPayouts: vi.fn() }));

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-27T12:00:00Z");
const payout = (status: FetchedPayout["status"]): FetchedPayout => ({
	externalId: "p1",
	status,
	depositedAt: new Date("2026-10-20T12:00:00Z"),
	amount: 100,
	currency: "USD",
	bankTail: null,
	reference: null,
});

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
	held = false;
	vi.mocked(fetchShopifyPayouts).mockReset();
});

test("an overlapping refresh skips rather than saving older word over newer", async () => {
	let answer = (_: FetchedPayout[]) => {};
	vi.mocked(fetchShopifyPayouts).mockReturnValueOnce(
		new Promise((resolve) => {
			answer = resolve;
		}),
	);
	const first = refreshPayouts(db, "shopify", now);
	await vi.waitFor(() => expect(fetchShopifyPayouts).toHaveBeenCalledOnce());
	expect(await refreshPayouts(db, "shopify", now)).toEqual({ kind: "busy" });
	answer([payout("sent")]);
	expect(await first).toEqual({ kind: "saved", saved: 1 });
	const [saved] = await db
		.select({ status: payouts.status })
		.from(payouts)
		.where(eq(payouts.externalId, "p1"));
	expect(saved.status).toBe("sent");
	expect(fetchShopifyPayouts).toHaveBeenCalledOnce();
});

test("a payout pending from long ago keeps the refresh looking back to it", async () => {
	expect(await refreshSince(db, "shopify", now)).toEqual(
		new Date(now.getTime() - 45 * DAY),
	);
	const pendingSince = async (channel: "shopify" | "ebay", days: number) =>
		db.insert(payouts).values({
			...payout("pending"),
			externalId: `${channel}-${days}`,
			channel,
			depositedAt: new Date(now.getTime() - days * DAY),
		});
	// Another channel's, or one that already went, moves nothing.
	await pendingSince("ebay", 200);
	await db.insert(payouts).values({
		...payout("sent"),
		channel: "shopify",
		depositedAt: new Date(now.getTime() - 200 * DAY),
	});
	expect(await refreshSince(db, "shopify", now)).toEqual(
		new Date(now.getTime() - 45 * DAY),
	);
	await pendingSince("shopify", 100);
	expect(await refreshSince(db, "shopify", now)).toEqual(
		new Date(now.getTime() - 130 * DAY),
	);
	// Only so far back.
	await pendingSince("shopify", 900);
	expect(await refreshSince(db, "shopify", now)).toEqual(
		new Date(now.getTime() - 365 * DAY),
	);
});
