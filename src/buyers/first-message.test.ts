import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { buyerChatStarts, buyerThreads, orders, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { firstEbayMessage } from "./first-message";
import { openChat } from "./start-chat";

// The first message to an eBay buyer, against eBay's order and Message APIs
// as a test answers them: each try is written down before eBay is asked,
// and a key already used reads its try back instead of sending again.

let db: Db;
let ebayOrder: number;
let tiktokOrder: number;
let sendAnswer: () => Response;
type Listed = {
	conversationId: string;
	latestMessage: object;
	referenceType?: string;
	referenceId?: string;
};
let listed: Listed[];
// A second page of conversations, and each conversation's messages.
let listedNext: Listed[];
let history: Record<string, object[]>;
const sends: unknown[] = [];
const fetchMock = vi.fn(ebay);

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

async function ebay(url: string, init?: RequestInit) {
	const u = new URL(url);
	if (u.pathname === "/identity/v1/oauth2/token")
		return json(200, { access_token: "t", expires_in: 7200 });
	if (u.pathname === "/ws/api.dll")
		return new Response("<User><UserID>ECDrywall</UserID></User>");
	if (u.pathname.startsWith("/sell/fulfillment/v1/order/"))
		return json(200, {
			buyer: { username: "buyer1" },
			lineItems: [{ legacyItemId: "item-1" }],
		});
	if (u.pathname === "/commerce/message/v1/send_message") {
		sends.push(JSON.parse(String(init?.body)));
		// Slow enough that a second request lands while this one is out.
		await new Promise((r) => setTimeout(r, 20));
		return sendAnswer();
	}
	if (u.pathname === "/commerce/message/v1/conversation")
		return u.searchParams.has("offset")
			? json(200, { conversations: listedNext })
			: json(200, {
					conversations: listed,
					...(listedNext.length ? { next: `${url}&offset=50` } : {}),
				});
	const one = /\/conversation\/([^/]+)$/.exec(u.pathname)?.[1];
	if (one) return json(200, { messages: history[one] ?? [] });
	throw new Error(`Unexpected ${url}`);
}

async function order(channel: "ebay" | "tiktok", externalId: string) {
	const [store] = await db
		.insert(stores)
		.values({ channel, name: channel })
		.returning();
	const [o] = await db
		.insert(orders)
		.values({
			storeId: store?.id ?? 0,
			externalId,
			name: externalId,
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 40,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	return o?.id ?? 0;
}

beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("EBAY_CLIENT_ID", "id");
	vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
	vi.stubEnv("EBAY_REFRESH_TOKEN", "refresh");
	sends.length = 0;
	listed = [];
	listedNext = [];
	history = {};
	sendAnswer = () => {
		listed = [
			{
				conversationId: "c9",
				latestMessage: {
					messageId: "m1",
					createdDate: new Date().toISOString(),
				},
			},
		];
		return json(201, { messageId: "m1" });
	};
	fetchMock.mockClear();
	vi.stubGlobal("fetch", fetchMock);
	ebayOrder = await order("ebay", "12-1");
	tiktokOrder = await order("tiktok", "577");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const key = "7f1c2a4e-9b8d-4c3e-a1f0-0e9d8c7b6a51";

test("two requests with one key at once send once", async () => {
	const [a, b] = await Promise.all([
		firstEbayMessage(db, ebayOrder, "Hi, about your return", key),
		firstEbayMessage(db, ebayOrder, "Hi, about your return", key),
	]);
	expect(sends).toHaveLength(1);
	expect([a.kind, b.kind].sort()).toEqual(["sending", "sent"]);
	const [thread] = await db.select().from(buyerThreads);
	expect(thread).toMatchObject({ externalId: "c9", orderRef: "12-1" });
});

test("the message is found deeper in a conversation on a later page", async () => {
	const at = (minutes: number) =>
		new Date(Date.now() + minutes * 60_000).toISOString();
	sendAnswer = () => {
		listed = [
			{
				conversationId: "c1",
				latestMessage: { messageId: "x1", createdDate: at(0) },
			},
		];
		// The buyer answered at once: ours isn't the latest.
		listedNext = [
			{
				conversationId: "c9",
				latestMessage: { messageId: "m2", createdDate: at(1) },
			},
		];
		history = {
			c1: [{ messageId: "x1", createdDate: at(0) }],
			c9: [
				{
					messageId: "m1",
					messageBody: "Hi",
					senderUsername: "ECDrywall",
					createdDate: at(0),
				},
				{
					messageId: "m2",
					messageBody: "Thanks",
					senderUsername: "buyer1",
					createdDate: at(1),
				},
			],
		};
		return json(201, { messageId: "m1" });
	};
	const r = await firstEbayMessage(db, ebayOrder, "Hi", key);
	expect(r.kind).toBe("sent");
	const [thread] = await db.select().from(buyerThreads);
	expect(thread).toMatchObject({ externalId: "c9", orderRef: "12-1" });
});

test("opening the chat finds the listing's conversation on a later page", async () => {
	const latest = { messageId: "x", createdDate: new Date().toISOString() };
	listed = [{ conversationId: "c1", latestMessage: latest }];
	listedNext = [
		{
			conversationId: "c7",
			latestMessage: latest,
			referenceType: "LISTING",
			referenceId: "item-1",
		},
	];
	const opened = await openChat(db, ebayOrder);
	const [thread] = await db.select().from(buyerThreads);
	expect(thread).toMatchObject({ externalId: "c7", itemRef: "item-1" });
	expect(opened).toEqual({ kind: "opened", threadId: thread?.id });
});

test("asking again after a lost answer reads the try back", async () => {
	const first = await firstEbayMessage(db, ebayOrder, "Hi", key);
	const again = await firstEbayMessage(db, ebayOrder, "Hi", key);
	expect(again).toEqual(first);
	expect(again.kind).toBe("sent");
	expect(sends).toHaveLength(1);
});

test("an unclear answer is kept unsure and shown when the chat reopens", async () => {
	sendAnswer = () => json(503, { errors: [] });
	const r = await firstEbayMessage(db, ebayOrder, "Hi", key);
	expect(r.kind).toBe("unsure");
	const [kept] = await db.select().from(buyerChatStarts);
	expect(kept?.status).toBe("unsure");
	// The same key never sends it again.
	expect((await firstEbayMessage(db, ebayOrder, "Hi", key)).kind).toBe(
		"unsure",
	);
	expect(sends).toHaveLength(1);
	const opened = await openChat(db, ebayOrder);
	expect(opened).toMatchObject({
		kind: "compose",
		to: "buyer1",
		last: { body: "Hi", outcome: { kind: "unsure" } },
	});
});

test("eBay's plain no didn't go, and isn't shown on reopening", async () => {
	sendAnswer = () => json(400, { errors: [{ errorId: 355006 }] });
	expect((await firstEbayMessage(db, ebayOrder, "Hi", key)).kind).toBe(
		"refused",
	);
	expect(await openChat(db, ebayOrder)).toMatchObject({
		kind: "compose",
		last: null,
	});
});

test("another channel's order is refused before eBay is asked", async () => {
	const r = await firstEbayMessage(db, tiktokOrder, "Hi", key);
	expect(r.kind).toBe("refused");
	expect(fetchMock).not.toHaveBeenCalled();
	expect(await db.select().from(buyerChatStarts)).toEqual([]);
});
