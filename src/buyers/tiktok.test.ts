import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("#/channels/tiktok", async (actual) => {
	const real = await actual<typeof import("#/channels/tiktok")>();
	return {
		TiktokError: real.TiktokError,
		retryLater: real.retryLater,
		shopCipher: async () => "cipher",
		tiktokApi: vi.fn(),
		tiktokUpload: vi.fn(async () => ({
			url: "https://p16.tiktok/up.png",
			width: 4,
			height: 3,
		})),
	};
});

import { TiktokError, tiktokApi, tiktokUpload } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import { buyerMessageChecks } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { addReplyFile } from "./reply-files";
import { reply, settleReplies } from "./send";
import { threadsPage } from "./threads";
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
let sendAnswer: () => unknown;
const sent: unknown[] = [];

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
	sent.length = 0;
	sendAnswer = () => ({ message_id: "s1" });
	vi.mocked(tiktokApi).mockReset();
	vi.mocked(tiktokApi).mockImplementation(async (path, _query, body) => {
		if (path === "/customer_service/202309/conversations")
			return {
				conversations: Object.entries(conversations).map(([id, ms]) => ({
					id,
					participants: [
						{ role: "SHOP", nickname: "ECDT" },
						{ role: "BUYER", nickname: "drywaller7" },
					],
					latest_message: latestFirst(ms)[0],
				})),
				next_page_token: "",
			};
		const one = /conversations\/([^/]+)\/messages$/.exec(path)?.[1];
		if (one && body) {
			sent.push(body);
			return sendAnswer();
		}
		if (one)
			return {
				messages: latestFirst(conversations[one] ?? []),
				next_page_token: "",
			};
		throw new Error(`Unexpected ${path}`);
	});
});

describe("TikTok messages", () => {
	test("a chat a buyer wrote in is a thread about its order, without TikTok's notices", async () => {
		expect(await syncTiktokMessages(db)).toEqual({ read: 1, problems: [] });
		const threads = await threadsPage(db, "open", null);
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({
			market: "tiktok",
			buyerName: "drywaller7",
			orderRef: "5770001",
		});
		expect(threads[0]?.messages.map((m) => m.body)).toEqual([
			"Where is my order?",
		]);
		expect(threads[0]?.waiting).not.toBeNull();
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

	test("an answer from Seller Center counts as ours", async () => {
		conversations.c1?.push(text("h1", "CUSTOMER_SERVICE", "On its way", -2));
		await syncTiktokMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		expect(thread?.waiting).toBeNull();
	});

	test("a reply goes into the conversation and is delivered once", async () => {
		await syncTiktokMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		const r = await reply(
			db,
			thread?.id ?? 0,
			"Tomorrow.",
			crypto.randomUUID(),
		);
		expect(r.status).toBe("delivered");
		expect(sent).toEqual([
			{ type: "TEXT", content: JSON.stringify({ content: "Tomorrow." }) },
		]);
		conversations.c1?.push({ ...text("s1", "SHOP", "Tomorrow.", 0) });
		await syncTiktokMessages(db);
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages).toHaveLength(2);
		expect(after?.waiting).toBeNull();
	});

	test("a refusal fails the reply; an unsure send is only looked for", async () => {
		await syncTiktokMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		sendAnswer = () => {
			throw new TiktokError(12052001, "send", "Conversation closed");
		};
		const no = await reply(db, thread?.id ?? 0, "No", crypto.randomUUID());
		expect(no.status).toBe("failed");
		sendAnswer = () => {
			throw new TiktokError(36009003, "send", "Internal error. Retry later");
		};
		const maybe = await reply(
			db,
			thread?.id ?? 0,
			"Maybe",
			crypto.randomUUID(),
		);
		expect(maybe.status).toBe("sending");
		// TikTok had it after all.
		conversations.c1?.push(text("s2", "SHOP", "Maybe", 0));
		await settleReplies(db, Date.now() + 120_000);
		expect(sent).toHaveLength(2);
		const [after] = await threadsPage(db, "open", null);
		expect(
			after?.messages.filter((m) => !m.fromBuyer).map((m) => m.status),
		).toEqual(["failed", "delivered"]);
	});

	test("a picture from the buyer is kept as one", async () => {
		conversations.c1?.push({
			...card("b2", "IMAGE", { url: "https://p16.tiktok/box.jpg" }, -1),
			sender: { role: "BUYER", nickname: "drywaller7" },
		});
		await syncTiktokMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		expect(thread?.messages.at(-1)).toMatchObject({
			body: "",
			media: [{ kind: "IMAGE", url: "https://p16.tiktok/box.jpg" }],
		});
	});

	test("pictures go up once, each as its own message before the words, and aren't read back twice", async () => {
		await syncTiktokMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		const photo = await addReplyFile(db, {
			filename: "box.png",
			contentType: "image/png",
			data: new Uint8Array([1, 2]),
		});
		const pdf = await addReplyFile(db, {
			filename: "label.pdf",
			contentType: "application/pdf",
			data: new Uint8Array([1]),
		});
		await expect(
			reply(db, thread?.id ?? 0, "", crypto.randomUUID(), [pdf.id]),
		).rejects.toThrow(/Takes pictures/);
		let n = 0;
		sendAnswer = () => ({ message_id: `s${++n}` });
		const r = await reply(db, thread?.id ?? 0, "Here", crypto.randomUUID(), [
			photo.id,
		]);
		expect(r.status).toBe("delivered");
		expect(tiktokUpload).toHaveBeenCalledTimes(1);
		const image = { url: "https://p16.tiktok/up.png", width: 4, height: 3 };
		expect(sent).toEqual([
			{ type: "IMAGE", content: JSON.stringify(image) },
			{ type: "TEXT", content: JSON.stringify({ content: "Here" }) },
		]);
		// Read back: the picture and the words, still one reply.
		conversations.c1?.push(
			{
				...card("s1", "IMAGE", image, 0),
				sender: { role: "SHOP", nickname: "ECDT" },
			},
			text("s2", "SHOP", "Here", 0),
		);
		await syncTiktokMessages(db, { sweep: true });
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages.filter((m) => !m.fromBuyer)).toHaveLength(1);
		expect(after?.messages.at(-1)?.media).toMatchObject([
			{ kind: "IMAGE", fileId: photo.id, externalId: "s1" },
		]);
	});

	test("pictures without words are delivered only once every one is found", async () => {
		await syncTiktokMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		const ids = [];
		for (const name of ["a.png", "b.png"])
			ids.push(
				(
					await addReplyFile(db, {
						filename: name,
						contentType: "image/png",
						data: new Uint8Array([1]),
					})
				).id,
			);
		// The first goes and TikTok gives no ID: nothing more is sent.
		sendAnswer = () => ({});
		const r = await reply(db, thread?.id ?? 0, "", crypto.randomUUID(), ids);
		expect(r.status).toBe("sending");
		expect(sent).toHaveLength(1);
		const image = { url: "https://p16.tiktok/up.png", width: 4, height: 3 };
		const ours = (id: string) => ({
			...card(id, "IMAGE", image, 0),
			sender: { role: "SHOP", nickname: "ECDT" },
		});
		conversations.c1?.push(ours("p1"));
		await settleReplies(db, Date.now() + 120_000);
		const mine = async () =>
			(await threadsPage(db, "open", null))[0]?.messages.filter(
				(m) => !m.fromBuyer,
			);
		// One of two found: not delivered, and not a second reply either.
		expect((await mine())?.map((m) => m.status)).toEqual(["sending"]);
		await settleReplies(db, Date.now() + 20 * 60_000);
		expect((await mine())?.map((m) => m.status)).toEqual(["unconfirmed"]);
		// Both found after all (sent from Seller Center, say): delivered.
		conversations.c1?.push(ours("p2"));
		await syncTiktokMessages(db, { sweep: true });
		expect((await mine())?.map((m) => m.status)).toEqual(["delivered"]);
	});
});
