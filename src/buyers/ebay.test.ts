import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { buyerMessageChecks, buyerMessages, buyerThreads } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { syncEbayMessages } from "./ebay-messages";
import { countWaiting } from "./threads";

// eBay's Message API, answered from a list of conversations and their
// messages that a test can change between runs.

let db: Db;
let conversations: Record<string, { title: string; messages: Msg[] }>;

type Msg = {
	messageId: string;
	messageBody: string;
	senderUsername: string;
	recipientUsername: string;
	createdDate: string;
	messageMedia?: { mediaType: string; mediaName: string; mediaUrl: string }[];
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

function ebay(url: string) {
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
	vi.stubGlobal("fetch", vi.fn(ebay));
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

// Every message kept, oldest first.
const kept = () =>
	db.select().from(buyerMessages).orderBy(buyerMessages.at, buyerMessages.id);

describe("eBay messages", () => {
	test("reads each conversation once, telling ours from the buyer's", async () => {
		conversations.c1?.messages.push(msg("m0", "ECDrywall", "Thanks!", -9));
		expect(await syncEbayMessages(db)).toEqual({ read: 1, problems: [] });
		expect(await syncEbayMessages(db)).toEqual({ read: 0, problems: [] });
		const [thread] = await db.select().from(buyerThreads);
		expect(thread).toMatchObject({
			market: "ebay",
			buyerName: "buyer1",
			itemRef: "1234",
			subject: "About your scraper",
		});
		// Answered on eBay itself.
		expect(await countWaiting(db, "ebay")).toBe(0);
		const [check] = await db.select().from(buyerMessageChecks);
		expect(check).toMatchObject({ market: "ebay", error: null });
		expect(check?.readThrough).not.toBeNull();
	});

	test("waits on us until a reply on eBay is read back", async () => {
		await syncEbayMessages(db);
		expect(await countWaiting(db, "ebay")).toBe(1);
		conversations.c1?.messages.push(msg("m2", "ECDrywall", "Yes, it fits.", 0));
		await syncEbayMessages(db);
		expect((await kept()).map((m) => [m.body, m.fromBuyer])).toEqual([
			["Does it fit a 10in box?", true],
			["Yes, it fits.", false],
		]);
		expect(await countWaiting(db, "ebay")).toBe(0);
		// Read again, nothing's doubled.
		await syncEbayMessages(db, { sweep: true });
		expect(await kept()).toHaveLength(2);
	});

	test("a buyer's message before one of ours is still read", async () => {
		await syncEbayMessages(db);
		conversations.c1?.messages.push(msg("b2", "buyer1", "Also, red?", -1));
		conversations.c1?.messages.push(msg("m2", "ECDrywall", "Yes, it fits.", 0));
		await syncEbayMessages(db);
		expect((await kept()).map((m) => m.body)).toEqual([
			"Does it fit a 10in box?",
			"Also, red?",
			"Yes, it fits.",
		]);
	});

	test("a photo with no words keeps the photo, filled in on a read again", async () => {
		conversations.c1?.messages.push(msg("m3", "buyer1", "", -5));
		await syncEbayMessages(db);
		expect((await kept())[1]?.media).toEqual([]);
		const photo = {
			mediaType: "IMAGE",
			mediaName: "box.jpg",
			mediaUrl: "https://i.ebayimg.com/box",
		};
		const last = conversations.c1?.messages.at(-1);
		if (last) last.messageMedia = [photo];
		// What the migration does, so photos already read are read again.
		await db.update(buyerThreads).set({ readLatestId: null });
		await db.update(buyerMessageChecks).set({ readThrough: null });
		await syncEbayMessages(db);
		const messages = await kept();
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			body: "",
			media: [{ kind: "IMAGE", name: "box.jpg", url: photo.mediaUrl }],
		});
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
