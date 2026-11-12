import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("#/channels/tiktok", async (actual) => {
	const real = await actual<typeof import("#/channels/tiktok")>();
	return {
		searchPage: real.searchPage,
		shopCipher: async () => "cipher",
		tiktokApi: vi.fn(),
	};
});

import { tiktokApi } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import { buyerMessageChecks, buyerMessages, buyerThreads } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { countWaiting } from "./threads";
import { syncTiktokMessages } from "./tiktok-messages";

// TikTok's Customer Service API, answered from conversations a test can
// change between runs, shaped as TikTok sent them.

type Msg = {
	id: string;
	type: string;
	content: string;
	create_time: number;
	is_visible: boolean;
	sender: { role: string; nickname: string };
};

let db: Db;
let conversations: Record<string, Msg[]>;
// Each buyer's orders on TikTok, latest first, by their user ID (u-<chat>).
let buyerOrders: Record<string, string[]>;

// A message this many minutes from now (before, when negative).
const at = (minutes: number) => Math.floor(Date.now() / 1000 + minutes * 60);
const text = (id: string, role: string, words: string, minutes: number) => ({
	id,
	type: "TEXT",
	content: JSON.stringify({ content: words }),
	create_time: at(minutes),
	is_visible: true,
	sender: { role, nickname: role === "BUYER" ? "drywaller7" : "ECDT" },
});
const card = (id: string, type: string, content: object, minutes: number) => ({
	id,
	type,
	content: JSON.stringify(content),
	create_time: at(minutes),
	is_visible: true,
	sender: { role: "ROBOT", nickname: "ECDT" },
});

const latestFirst = (ms: Msg[]) =>
	[...ms].sort((a, b) => b.create_time - a.create_time);

beforeEach(async () => {
	db = await createTestDb();
	conversations = {
		c1: [
			card("o1", "ORDER_CARD", { order_id: "5770001" }, -30),
			text("r1", "ROBOT", "Thanks for your order!", -30),
			text("b1", "BUYER", "Where is my order?", -10),
		],
		// Only TikTok's notices: no buyer wrote, so no thread. Older than the
		// overlap each run reads again, so it isn't.
		c2: [text("r2", "ROBOT", "Your order shipped", -30)],
	};
	buyerOrders = {};
	vi.mocked(tiktokApi).mockReset();
	vi.mocked(tiktokApi).mockImplementation(async (path, _query, body) => {
		if (path === "/customer_service/202309/conversations")
			return {
				conversations: Object.entries(conversations).map(([id, ms]) => ({
					id,
					participants: [
						{ role: "SHOP", nickname: "ECDT" },
						{ role: "BUYER", nickname: "drywaller7", user_id: `u-${id}` },
					],
					latest_message: latestFirst(ms)[0],
				})),
				next_page_token: "",
			};
		if (path === "/order/202309/orders/search") {
			const { buyer_user_id } = body as { buyer_user_id: string };
			return {
				orders: (buyerOrders[buyer_user_id] ?? []).map((id) => ({ id })),
				next_page_token: "",
			};
		}
		const one = /conversations\/([^/]+)\/messages$/.exec(path)?.[1];
		if (one)
			return {
				messages: latestFirst(conversations[one] ?? []),
				next_page_token: "",
			};
		throw new Error(`Unexpected ${path}`);
	});
});

// The threads kept, and every message, oldest first.
const threads = () => db.select().from(buyerThreads);
const kept = () =>
	db.select().from(buyerMessages).orderBy(buyerMessages.at, buyerMessages.id);

describe("TikTok messages", () => {
	test("a chat a buyer wrote in is a thread about its order, without TikTok's notices", async () => {
		expect(await syncTiktokMessages(db)).toEqual({ read: 1, problems: [] });
		const all = await threads();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			market: "tiktok",
			buyerName: "drywaller7",
			orderRef: "5770001",
		});
		expect((await kept()).map((m) => m.body)).toEqual(["Where is my order?"]);
		expect(await countWaiting(db, "tiktok")).toBe(1);
		// Nothing new: neither is read again.
		vi.mocked(tiktokApi).mockClear();
		expect(await syncTiktokMessages(db)).toEqual({ read: 0, problems: [] });
		const reads = vi
			.mocked(tiktokApi)
			.mock.calls.filter(([p]) => p.endsWith("/messages"));
		expect(reads).toEqual([]);
		const [check] = await db.select().from(buyerMessageChecks);
		expect(check).toMatchObject({ market: "tiktok", error: null });
	});

	test("a chat whose card TikTok hides is about the buyer's latest order", async () => {
		// TikTok's order card, as its API gives it: no order ID.
		const hidden = card(
			"o3",
			"OTHER",
			{ content: "[Other] Please check this message in seller center" },
			-30,
		);
		conversations = {
			c3: [hidden, text("b3", "BUYER", "When will it arrive?", -10)],
		};
		// Not findable on TikTok yet: the thread waits without one.
		expect(await syncTiktokMessages(db)).toEqual({ read: 1, problems: [] });
		expect((await threads())[0]?.orderRef).toBeNull();
		// Nothing new in the chat, but a waiting thread asks again.
		buyerOrders = { "u-c3": ["5770009", "5770002"] };
		expect(await syncTiktokMessages(db)).toEqual({ read: 0, problems: [] });
		expect((await threads())[0]?.orderRef).toBe("5770009");
		// Once tied, TikTok isn't asked again.
		vi.mocked(tiktokApi).mockClear();
		await syncTiktokMessages(db);
		expect(
			vi.mocked(tiktokApi).mock.calls.filter(([p]) => p.includes("/order/")),
		).toEqual([]);
	});

	test("a card about another order moves the thread", async () => {
		await syncTiktokMessages(db);
		conversations.c1?.push(
			card("o2", "ORDER_CARD", { order_id: "5770002" }, -2),
			text("b2", "BUYER", "And this one?", -1),
		);
		await syncTiktokMessages(db);
		expect((await threads())[0]?.orderRef).toBe("5770002");
	});

	test("a chat with an order card never asks TikTok for the buyer's orders", async () => {
		await syncTiktokMessages(db);
		expect(
			vi.mocked(tiktokApi).mock.calls.filter(([p]) => p.includes("/order/")),
		).toEqual([]);
	});

	test("TikTok's own messages never answer the buyer", async () => {
		conversations.c1?.push(
			text("r3", "ROBOT", "Se vende en paquetes de 5.", -9),
			{
				...card("n1", "NOTIFICATION", { content: "The chat timed out" }, -8),
				sender: { role: "SYSTEM", nickname: "ECDT" },
			},
		);
		await syncTiktokMessages(db);
		await syncTiktokMessages(db, { sweep: true });
		expect((await kept()).map((m) => m.body)).toEqual(["Where is my order?"]);
		expect(await countWaiting(db, "tiktok")).toBe(1);
	});

	test("an answer from Seller Center counts as ours", async () => {
		conversations.c1?.push(text("h1", "CUSTOMER_SERVICE", "On its way", -2));
		await syncTiktokMessages(db);
		expect(await countWaiting(db, "tiktok")).toBe(0);
	});

	test("a picture from the buyer is kept as one", async () => {
		conversations.c1?.push({
			...card("b2", "IMAGE", { url: "https://p16.tiktok/box.jpg" }, -1),
			sender: { role: "BUYER", nickname: "drywaller7" },
		});
		await syncTiktokMessages(db);
		expect((await kept()).at(-1)).toMatchObject({
			body: "",
			media: [{ kind: "IMAGE", url: "https://p16.tiktok/box.jpg" }],
		});
	});
});
