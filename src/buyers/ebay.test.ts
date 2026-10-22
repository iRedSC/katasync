import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { buyerMessageChecks } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { syncEbayMessages } from "./ebay-messages";
import { reply, settleReplies } from "./send";
import { threadsPage } from "./threads";

// eBay's Message API, answered from a list of conversations and their
// messages that a test can change between runs.

let db: Db;
let conversations: Record<string, { title: string; messages: Msg[] }>;
let sendAnswer: () => Response;
const sent: unknown[] = [];

type Msg = {
	messageId: string;
	messageBody: string;
	senderUsername: string;
	recipientUsername: string;
	createdDate: string;
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

function ebay(url: string, init?: RequestInit) {
	const u = new URL(url);
	if (u.pathname === "/identity/v1/oauth2/token")
		return json(200, { access_token: "t", expires_in: 7200 });
	if (u.pathname === "/ws/api.dll")
		return new Response(
			"<GetUserResponse><User><UserID>ECDrywall</UserID></User></GetUserResponse>",
		);
	if (u.pathname === "/commerce/message/v1/conversation")
		return json(200, {
			conversations: Object.entries(conversations).map(([id, c]) => ({
				conversationId: id,
				conversationTitle: c.title,
				referenceType: "LISTING",
				referenceId: "1234",
				latestMessage: c.messages.at(-1),
			})),
		});
	const one = /\/conversation\/([^/]+)$/.exec(u.pathname)?.[1];
	if (one) return json(200, { messages: conversations[one]?.messages ?? [] });
	if (u.pathname === "/commerce/message/v1/send_message") {
		sent.push(JSON.parse(String(init?.body)));
		return sendAnswer();
	}
	throw new Error(`Unexpected ${url}`);
}

// A message this many minutes from now (before, when negative).
const msg = (id: string, from: string, body: string, minutes: number): Msg => ({
	messageId: id,
	messageBody: body,
	senderUsername: from,
	recipientUsername: from === "buyer1" ? "ECDrywall" : "buyer1",
	createdDate: new Date(Date.now() + minutes * 60_000).toISOString(),
});

beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("EBAY_CLIENT_ID", "id");
	vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
	vi.stubEnv("EBAY_REFRESH_TOKEN", "refresh");
	conversations = {
		c1: {
			title: "About your scraper",
			messages: [msg("m1", "buyer1", "Does it fit a 10in box?", -10)],
		},
	};
	sent.length = 0;
	sendAnswer = () => json(201, { messageId: "m2" });
	vi.stubGlobal("fetch", vi.fn(ebay));
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("eBay messages", () => {
	test("reads each conversation once, telling ours from the buyer's", async () => {
		conversations.c1?.messages.push(msg("m0", "ECDrywall", "Thanks!", -9));
		expect(await syncEbayMessages(db)).toEqual({ read: 1, problems: [] });
		expect(await syncEbayMessages(db)).toEqual({ read: 0, problems: [] });
		const [thread] = await threadsPage(db, "open", null);
		expect(thread).toMatchObject({
			market: "ebay",
			buyerName: "buyer1",
			itemRef: "1234",
			subject: "About your scraper",
			// Answered on eBay itself.
			waiting: null,
		});
		const [check] = await db.select().from(buyerMessageChecks);
		expect(check).toMatchObject({ market: "ebay", error: null });
		expect(check?.readThrough).not.toBeNull();
	});

	test("a reply goes into the conversation and is delivered", async () => {
		await syncEbayMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		expect(thread?.waiting).not.toBeNull();
		const r = await reply(
			db,
			thread?.id ?? 0,
			"Yes, it fits.",
			crypto.randomUUID(),
		);
		expect(r.status).toBe("delivered");
		expect(sent).toEqual([
			{ conversationId: "c1", messageText: "Yes, it fits." },
		]);
		// Read back from eBay, it's the same message, not a second one.
		conversations.c1?.messages.push(msg("m2", "ECDrywall", "Yes, it fits.", 0));
		await syncEbayMessages(db);
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages).toHaveLength(2);
		expect(after?.waiting).toBeNull();
	});

	test("an unsure send is never sent again, only found or given up on", async () => {
		await syncEbayMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		sendAnswer = () => json(503, { error: "busy" });
		expect(
			(await reply(db, thread?.id ?? 0, "First", crypto.randomUUID())).status,
		).toBe("sending");
		sendAnswer = () => json(503, { error: "busy" });
		expect(
			(await reply(db, thread?.id ?? 0, "Second", crypto.randomUUID())).status,
		).toBe("sending");
		// eBay had the first after all.
		conversations.c1?.messages.push(msg("m3", "ECDrywall", "First", 0));
		await settleReplies(db, Date.now() + 120_000);
		await settleReplies(db, Date.now() + 20 * 60_000);
		expect(sent).toHaveLength(2);
		const [after] = await threadsPage(db, "open", null);
		expect(
			after?.messages
				.filter((m) => !m.fromBuyer)
				.map((m) => [m.body, m.status]),
		).toEqual([
			["First", "delivered"],
			// Never found: it may have gone, so it isn't called failed.
			["Second", "unconfirmed"],
		]);
	});

	test("a buyer's message before one of ours is still read", async () => {
		await syncEbayMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		conversations.c1?.messages.push(msg("b2", "buyer1", "Also, red?", -1));
		await reply(db, thread?.id ?? 0, "Yes, it fits.", crypto.randomUUID());
		conversations.c1?.messages.push(msg("m2", "ECDrywall", "Yes, it fits.", 0));
		await syncEbayMessages(db);
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages.map((m) => m.body)).toEqual([
			"Does it fit a 10in box?",
			"Also, red?",
			"Yes, it fits.",
		]);
	});

	test("the same words sent before don't settle a new reply", async () => {
		conversations.c1?.messages.push(msg("m0", "ECDrywall", "Thanks!", -9));
		await syncEbayMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		sendAnswer = () => json(503, {});
		await reply(db, thread?.id ?? 0, "Thanks!", crypto.randomUUID());
		// An old "Thanks!" no one claimed, from before this was written.
		conversations.c1?.messages.push(msg("m9", "ECDrywall", "Thanks!", -8));
		const r = await settleReplies(db, Date.now() + 20 * 60_000);
		expect(r.problems).toEqual([]);
		const [after] = await threadsPage(db, "open", null);
		expect(
			after?.messages.filter((m) => m.status === "unconfirmed"),
		).toHaveLength(1);
	});

	test("the same key twice is one reply, sent once", async () => {
		await syncEbayMessages(db);
		const [thread] = await threadsPage(db, "open", null);
		const key = crypto.randomUUID();
		const first = await reply(db, thread?.id ?? 0, "Yes", key);
		const again = await reply(db, thread?.id ?? 0, "Yes", key);
		expect(again).toEqual(first);
		expect(sent).toHaveLength(1);
	});

	test("without the message scope, says to sign in again", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json(400, { error: "invalid_scope" })),
		);
		// Fresh modules, so no token is kept from another test.
		vi.resetModules();
		const fresh = await import("./ebay-messages");
		const r = await fresh.syncEbayMessages(db);
		expect(r.problems[0]).toMatch(/Sign in to eBay again/);
		const [check] = await db.select().from(buyerMessageChecks);
		expect(check?.error).toMatch(/Sign in to eBay again/);
		expect(check?.checkedAt).toBeNull();
	});
});
