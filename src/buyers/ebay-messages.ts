import { type } from "arktype";
import { eq } from "drizzle-orm";
import { API, accessToken } from "#/channels/ebay";
import { scopedToken } from "#/channels/ebay-scoped-token";
import type { Db } from "#/db/client";
import { buyerMessageChecks, buyerThreads } from "#/db/schema";
import { keepConversation } from "./conversation";
import { Refused, Unsure, unsureStatus } from "./states";
import { ensureThread } from "./threads";

// eBay buyer messages through its Message API (commerce/message/v1): every
// conversation members started with us, read in each run from a little
// before the last full read, so a run that failed or ran late leaves no gap;
// and our replies sent into them. It needs the commerce.message scope, which
// takes signing in to eBay again once (pnpm ebay:authorize).

export const MESSAGE_SCOPE =
	"https://api.ebay.com/oauth/api_scope/commerce.message";
const BASE = `${API}/commerce/message/v1`;
const RECONNECT =
	"Sign in to eBay again to read messages (pnpm ebay:authorize)";

const message = type({
	messageId: "string",
	"messageBody?": "string",
	"senderUsername?": "string",
	"recipientUsername?": "string",
	createdDate: "string.date.iso.parse",
	"messageMedia?": type({
		"mediaType?": "string",
		"mediaName?": "string",
		mediaUrl: "string",
	}).array(),
});

// What a message carries besides words: pictures and files eBay hosts.
const mediaOf = (m: Message) =>
	(m.messageMedia ?? []).map((x) => ({
		kind: x.mediaType ?? "FILE",
		name: x.mediaName ?? "",
		url: x.mediaUrl,
	}));

const conversation = type({
	conversationId: "string",
	"conversationTitle?": "string",
	"referenceId?": "string",
	"referenceType?": "string",
	"latestMessage?": message,
});

const conversationsPage = type({
	"conversations?": conversation.array(),
	"next?": "string",
});

const messagesPage = type({
	"messages?": message.array(),
	"next?": "string",
});

type Message = typeof message.infer;

async function token() {
	const t = await scopedToken(MESSAGE_SCOPE);
	if (!t) throw new Error(RECONNECT);
	return t;
}

async function get(t: string, url: string) {
	const res = await fetch(url.startsWith("https://") ? url : BASE + url, {
		headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
	});
	if (!res.ok)
		throw new Error(`eBay answered ${res.status}: ${await res.text()}`);
	return res.json();
}

let me: string | undefined;

// The seller's own eBay user ID, to tell our messages from the buyer's.
async function sellerUsername() {
	if (me) return me;
	const res = await fetch(`${API}/ws/api.dll`, {
		method: "POST",
		headers: {
			"X-EBAY-API-CALL-NAME": "GetUser",
			"X-EBAY-API-SITEID": "0",
			"X-EBAY-API-COMPATIBILITY-LEVEL": "1349",
			"X-EBAY-API-IAF-TOKEN": await accessToken(),
			"Content-Type": "text/xml",
		},
		body: `<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"/>`,
	});
	const xml = await res.text();
	const id = /<UserID>([^<]+)<\/UserID>/.exec(xml)?.[1];
	if (!res.ok || !id) throw new Error(`eBay didn't say who we are: ${xml}`);
	me = id.toLowerCase();
	return me;
}

const ours = (m: Message, seller: string) =>
	m.senderUsername?.toLowerCase() === seller;

// Every message of one conversation, kept: the buyer's, ours sent on eBay,
// and ours sent from katasync whose outcome wasn't known, now settled.
async function readConversation(
	db: Db,
	t: string,
	seller: string,
	threadId: number,
	conversationId: string,
) {
	const all: Message[] = [];
	let url: string | undefined =
		`/conversation/${encodeURIComponent(conversationId)}?conversation_type=FROM_MEMBERS&limit=50`;
	while (url) {
		const page = messagesPage.assert(await get(t, url));
		all.push(...(page.messages ?? []));
		url = page.next;
	}
	await keepConversation(
		db,
		threadId,
		all.map((m) => ({
			externalId: m.messageId,
			body: m.messageBody ?? "",
			at: m.createdDate,
			ours: ours(m, seller),
			media: mediaOf(m),
		})),
	);
}

// Reads conversations with anything since a little before the last full
// read; on a sweep, two weeks. Records how it went, so a source that stops
// answering shows as broken.
export async function syncEbayMessages(db: Db, { sweep = false } = {}) {
	const startedAt = new Date();
	const [check] = await db
		.select()
		.from(buyerMessageChecks)
		.where(eq(buyerMessageChecks.market, "ebay"));
	const from = sweep
		? new Date(startedAt.getTime() - 14 * 86_400_000)
		: check?.readThrough
			? new Date(check.readThrough.getTime() - 2 * 86_400_000)
			: new Date(startedAt.getTime() - 30 * 86_400_000);
	const problems: string[] = [];
	// Why nothing could be read at all, apart from single conversations.
	let failed: string | undefined;
	let read = 0;
	try {
		const t = await token();
		const seller = await sellerUsername();
		let url: string | undefined =
			`/conversation?conversation_type=FROM_MEMBERS&start_time=${from.toISOString()}&limit=50`;
		while (url) {
			const page = conversationsPage.assert(await get(t, url));
			for (const c of page.conversations ?? []) {
				try {
					if (await syncConversation(db, t, seller, c, sweep)) read++;
				} catch (error) {
					problems.push(
						`${c.conversationTitle ?? c.conversationId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			url = page.next;
		}
	} catch (error) {
		failed = error instanceof Error ? error.message : String(error);
		problems.unshift(failed);
	}
	const set =
		problems.length === 0
			? {
					checkedAt: startedAt,
					error: null,
					erroredAt: null,
					...(sweep ? {} : { readThrough: startedAt }),
				}
			: { error: problems.join("; ").slice(0, 2000), erroredAt: new Date() };
	await db
		.insert(buyerMessageChecks)
		.values({ market: "ebay", ...set })
		.onConflictDoUpdate({ target: buyerMessageChecks.market, set });
	return { read, problems, failed };
}

// One conversation; false when its latest message was already kept.
async function syncConversation(
	db: Db,
	t: string,
	seller: string,
	c: typeof conversation.infer,
	sweep: boolean,
) {
	const latest = c.latestMessage;
	const buyer = latest
		? ours(latest, seller)
			? latest.recipientUsername
			: latest.senderUsername
		: undefined;
	const thread = await ensureThread(db, {
		market: "ebay",
		externalId: c.conversationId,
		subject: c.conversationTitle || "eBay message",
		buyerName: buyer ?? null,
		itemRef: c.referenceType === "LISTING" ? (c.referenceId ?? null) : null,
	});
	// Unchanged since it was last read in full. Our own sends don't count:
	// a buyer's message before one of ours would hide behind it.
	if (!sweep && latest && thread.readLatestId === latest.messageId)
		return false;
	await readConversation(db, t, seller, thread.id, c.conversationId);
	if (latest)
		await db
			.update(buyerThreads)
			.set({ readLatestId: latest.messageId })
			.where(eq(buyerThreads.id, thread.id));
	return true;
}

// Reads one thread's conversation again, to settle a reply whose send
// didn't say how it went.
export async function rereadEbayThread(db: Db, threadId: number) {
	const [thread] = await db
		.select()
		.from(buyerThreads)
		.where(eq(buyerThreads.id, threadId));
	if (!thread) return;
	await readConversation(
		db,
		await token(),
		await sellerUsername(),
		thread.id,
		thread.externalId,
	);
}

// Sends a reply into a conversation; eBay's message ID back. Throws Unsure
// when it may have gone anyway: eBay has no request key, so that's never
// sent again blind, only looked for (rereadEbayThread).
export async function sendEbayMessage(
	conversationId: string,
	text: string,
	media: { mediaName: string; mediaType: string; mediaUrl: string }[] = [],
) {
	let t: string;
	try {
		t = await token();
	} catch (error) {
		// Nothing was sent yet.
		throw new Refused(error instanceof Error ? error.message : String(error));
	}
	let res: Response;
	let body: string;
	try {
		res = await fetch(`${BASE}/send_message`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${t}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				conversationId,
				messageText: text,
				...(media.length ? { messageMedia: media } : {}),
			}),
		});
		body = await res.text();
	} catch (error) {
		throw new Unsure(error instanceof Error ? error.message : String(error));
	}
	if (res.ok) {
		let id: string | undefined;
		try {
			id = (JSON.parse(body) as { messageId?: string }).messageId;
		} catch {
			// Taken, but the answer didn't read: looked for later.
		}
		if (id) return id;
		throw new Unsure(`eBay took it without an ID: ${body}`);
	}
	const why = `eBay answered ${res.status}: ${body}`;
	throw unsureStatus(res.status) ? new Unsure(why) : new Refused(why);
}
