import { beforeEach, expect, test, vi } from "vitest";

vi.mock("#/channels/tiktok", async (actual) => {
	const real = await actual<typeof import("#/channels/tiktok")>();
	return {
		...real,
		shopCipher: async () => "cipher",
		tiktokApi: vi.fn(),
	};
});

import { TiktokError, tiktokApi } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import { buyerThreads, orders, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { openChat } from "./start-chat";

// Starting a TikTok conversation from an order: TikTok's no sends nothing
// and keeps nothing; its yes keeps an empty thread about the order.

let db: Db;
let orderId: number;
const api = vi.mocked(tiktokApi);

beforeEach(async () => {
	db = await createTestDb();
	api.mockReset();
	const [store] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok" })
		.returning();
	const [o] = await db
		.insert(orders)
		.values({
			storeId: store?.id ?? 0,
			externalId: "577",
			name: "577",
			buyerId: "7494560109732338459",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 40,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	orderId = o?.id ?? 0;
});

test("TikTok refusing leaves no thread and says why", async () => {
	api.mockRejectedValue(
		new TiktokError(12052701, "conversation", "Not allowed to start"),
	);
	const r = await openChat(db, orderId);
	expect(r.kind).toBe("refused");
	expect(r.kind === "refused" && r.reason).toContain("Not allowed to start");
	expect(await db.select().from(buyerThreads)).toEqual([]);
});

test("TikTok overloaded is a failure, not a refusal", async () => {
	api.mockRejectedValue(new TiktokError(36009003, "conversation", "Retry"));
	expect((await openChat(db, orderId)).kind).toBe("failed");
});

test("TikTok's yes keeps the conversation as a thread about the order", async () => {
	api.mockImplementation(async (path, _query, body) => {
		if (body) {
			expect(body).toEqual({ buyer_user_id: "7494560109732338459" });
			return { conversation_id: "c1" };
		}
		if (path.endsWith("/messages")) return { messages: [] };
		throw new Error(`unexpected ${path}`);
	});
	const r = await openChat(db, orderId);
	const [thread] = await db.select().from(buyerThreads);
	expect(r).toEqual({ kind: "started", threadId: thread?.id });
	expect(thread).toMatchObject({
		market: "tiktok",
		externalId: "c1",
		orderRef: "577",
	});
	// Opening sent nothing.
	expect(api.mock.calls.filter(([, , b]) => b)).toHaveLength(1);
});
