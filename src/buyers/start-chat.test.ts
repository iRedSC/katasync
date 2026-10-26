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
import { buyerMessages, buyerThreads, orders, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { draftFits } from "./chat-way";
import { setDraft } from "./drafts";
import { openChat } from "./start-chat";
import { threadsPage } from "./threads";

// Starting a TikTok conversation from an order: TikTok's no sends nothing
// and keeps nothing; its yes keeps an empty thread about the order.

let db: Db;
let orderId: number;
let storeId: number;
const api = vi.mocked(tiktokApi);

beforeEach(async () => {
	db = await createTestDb();
	api.mockReset();
	const [store] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok" })
		.returning();
	storeId = store?.id ?? 0;
	const [o] = await db
		.insert(orders)
		.values({
			storeId,
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

test("one buyer, two orders: the conversation stays about its order, and a suggestion only fits the one it's about", async () => {
	api.mockImplementation(async (path, _query, body) => {
		if (body) return { conversation_id: "c1" };
		if (path.endsWith("/messages")) return { messages: [] };
		throw new Error(`unexpected ${path}`);
	});
	const [b] = await db
		.insert(orders)
		.values({
			storeId,
			externalId: "578",
			name: "578",
			buyerId: "7494560109732338459",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 25,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	const fromA = await openChat(db, orderId);
	const threadId = fromA.kind === "started" ? fromA.threadId : 0;
	await db.insert(buyerMessages).values({
		threadId,
		fromBuyer: true,
		externalId: "b1",
		body: "Where is it?",
		at: new Date(),
	});
	await setDraft(db, threadId, { body: "It's on its way" }, "staff");
	// Opened from B: TikTok gives the same conversation, still about A.
	const fromB = await openChat(db, b?.id ?? 0);
	expect(fromB).toEqual({ kind: "started", threadId });
	const [t] = await threadsPage(db, { id: threadId }, null);
	expect(t?.orderRef).toBe("577");
	const draft = t?.draft ?? { forOrder: null };
	expect(draftFits(draft, "577")).toBe(true);
	expect(draftFits(draft, "578")).toBe(false);
	// One written from B is about B, and isn't offered for A.
	await setDraft(
		db,
		threadId,
		{ body: "Your second one ships today" },
		"staff",
		"578",
	);
	const [again] = await threadsPage(db, { id: threadId }, null);
	expect(again?.draft?.forOrder).toBe("578");
	expect(draftFits(again?.draft ?? { forOrder: null }, "577")).toBe(false);
	expect(again?.orderRef).toBe("577");
});
