import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { callTool, freshDb } from "#/mcp/mcp.fixtures";
import { attentionQueue } from "./queue";
import { readStanding } from "./refresh";
import { standing } from "./standing";

// A TikTok standing as a check leaves it: no verdict yet (the scope isn't
// granted), one product failed review, and the latest check failed.
async function seeded() {
	const { db, blade } = await freshDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "tiktok", name: "TikTok Shop" })
		.returning();
	await db.insert(schema.listings).values({
		storeId: store.id,
		externalId: "sku-1",
		title: "Blade on TikTok",
		productId: blade,
	});
	const now = new Date("2026-10-21T12:00:00Z");
	await db.insert(schema.marketStanding).values([
		{
			market: "tiktok",
			checkedAt: now,
			error: "TikTok answered 500",
			erroredAt: now,
			standing: standing(
				{ state: "needs_access", fix: "Sign in" },
				[],
				[
					{
						level: "watch",
						text: "Failed review: Abnormally Low Pricing",
						href: null,
						detail: "Raise the price.",
						items: [
							{
								listingId: "sku-1",
								ref: "BLADE-TT",
								label: "Blade",
								detail: null,
								href: null,
							},
							{
								listingId: "unknown",
								ref: "OTHER",
								label: "Not ours",
								detail: null,
								href: null,
							},
						],
					},
				],
			),
		},
		{
			market: "amazon",
			checkedAt: now,
			standing: standing(
				{ state: "read", level: "good", summary: "Great" },
				[],
				[
					{
						level: "at_risk",
						text: "2 listing policy violations",
						href: null,
						detail: null,
						items: [],
					},
				],
			),
		},
	]);
	return db;
}

let db: Db;
beforeEach(async () => {
	db = await seeded();
});

describe("attention queue", () => {
	test("worst first, failed checks included, listings matched to products", async () => {
		const queue = await attentionQueue(db, await readStanding(db));
		expect(queue.map((e) => [e.market, e.level, e.text])).toEqual([
			["amazon", "at_risk", "2 listing policy violations"],
			["tiktok", "watch", "Failed review: Abnormally Low Pricing"],
			["tiktok", "watch", "Couldn't check standing"],
		]);
		expect(queue[1].items.map((i) => i.product?.sku ?? null)).toEqual([
			"BLADE",
			null,
		]);
		expect(queue[2].detail).toBe("TikTok answered 500");
	});

	test("over MCP, filtered to one market", async () => {
		// Read-only apps get it too.
		const { isError, data } = await callTool(db, false, "markets", {
			market: "tiktok",
		});
		expect(isError).toBe(false);
		expect(data.standing).toEqual([
			expect.objectContaining({
				market: "tiktok",
				level: "watch",
				verdict: { state: "needs_access", fix: "Sign in" },
				lastCheckFailed: "TikTok answered 500",
			}),
		]);
		expect(data.queue.map((e: { market: string }) => e.market)).toEqual([
			"tiktok",
			"tiktok",
		]);
		expect(data.markets).toEqual([
			expect.objectContaining({ market: "tiktok", best: [] }),
		]);
	});
});
