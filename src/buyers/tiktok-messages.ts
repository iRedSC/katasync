import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import {
	retryLater,
	shopCipher,
	TiktokError,
	tiktokApi,
	tiktokUpload,
} from "#/channels/tiktok";
import type { Db } from "#/db/client";
import {
	type BuyerMedia,
	buyerMessageChecks,
	buyerMessages,
	buyerReplyFiles,
	buyerThreads,
} from "#/db/schema";
import { keepConversation, type ListedMessage } from "./conversation";
import { replyFileData } from "./reply-files";
import { Refused, Unsure } from "./states";
import { ensureThread } from "./threads";

// TikTok Shop buyer chats through its Customer Service API (202309): every
// conversation with something new since a little before the last full read,
// so a run that failed or ran late leaves no gap; and our replies sent into
// them. It needs the seller.customer_service scope (pnpm tiktok:authorize).
// TikTok opens a conversation for every order and fills it with its own
// notices (ROBOT and SYSTEM); only one a buyer wrote in becomes a thread.

const BASE = "/customer_service/202309/conversations";

const sender = type({
	role: "string",
	"nickname?": "string",
	"+": "ignore",
});

const message = type({
	id: "string",
	type: "string",
	content: "string",
	create_time: "number",
	"is_visible?": "boolean",
	sender,
	"+": "ignore",
});
type Message = typeof message.infer;

const conversation = type({
	id: "string",
	"participants?": sender.array(),
	"latest_message?": message,
	"+": "ignore",
});

const conversationsPage = type({
	"conversations?": conversation.array(),
	"next_page_token?": "string",
	"+": "ignore",
});

const messagesPage = type({
	"messages?": message.array(),
	"next_page_token?": "string",
	"+": "ignore",
});

// TikTok's notices: order and shipping updates, auto-replies, assignments.
const NOT_PEOPLE = new Set(["ROBOT", "SYSTEM"]);
const fromBuyer = (m: Message) => m.sender.role === "BUYER";
const fromPerson = (m: Message) =>
	m.is_visible !== false && !NOT_PEOPLE.has(m.sender.role);

// A message's content is JSON in a string, shaped by its type.
const contentOf = (m: Message): Record<string, unknown> => {
	try {
		const parsed: unknown = JSON.parse(m.content);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};
const field = (c: Record<string, unknown>, key: string) =>
	typeof c[key] === "string" ? c[key] : undefined;

// What a message says, and what it carries, as the Inbox shows it. A kind
// katasync doesn't read says where to see it.
export function readMessage(m: Message): { body: string; media: BuyerMedia[] } {
	const c = contentOf(m);
	const url = field(c, "url");
	switch (m.type) {
		case "TEXT":
			return { body: field(c, "content") ?? "", media: [] };
		case "IMAGE":
			return {
				body: "",
				media: url ? [{ kind: "IMAGE", name: "", url }] : [],
			};
		case "VIDEO":
			return {
				body: "",
				media: url ? [{ kind: "VIDEO", name: "", url }] : [],
			};
		case "ORDER_CARD":
			return { body: `Order ${field(c, "order_id") ?? ""}`.trim(), media: [] };
		case "PRODUCT_CARD":
			return {
				body: `Product ${field(c, "product_id") ?? ""}`.trim(),
				media: [],
			};
		default:
			return {
				body: `A ${m.type.toLowerCase().replaceAll("_", " ")}; open it in TikTok Seller Center`,
				media: [],
			};
	}
}

// The order the conversation is about: the latest one any card names.
export function orderOf(messages: Message[]) {
	for (const m of [...messages].sort((a, b) => b.create_time - a.create_time))
		if (m.type === "ORDER_CARD" || m.type === "LOGISTICS_CARD") {
			const id = field(contentOf(m), "order_id");
			if (id) return id;
		}
	return null;
}

const listed = (m: Message): ListedMessage => ({
	externalId: m.id,
	at: new Date(m.create_time * 1000),
	ours: !fromBuyer(m),
	...readMessage(m),
});

async function allMessages(cipher: string, conversationId: string) {
	const all: Message[] = [];
	let token = "";
	do {
		const page = messagesPage.assert(
			await tiktokApi(`${BASE}/${conversationId}/messages`, {
				shop_cipher: cipher,
				page_size: "10",
				...(token ? { page_token: token } : {}),
			}),
		);
		all.push(...(page.messages ?? []));
		token = page.next_page_token ?? "";
	} while (token);
	return all;
}

// Reads conversations with anything since a little before the last full
// read; on a sweep, two weeks. Records how it went, so a source that stops
// answering shows as broken.
export async function syncTiktokMessages(db: Db, { sweep = false } = {}) {
	const startedAt = new Date();
	const [check] = await db
		.select()
		.from(buyerMessageChecks)
		.where(eq(buyerMessageChecks.market, "tiktok"));
	const from = sweep
		? new Date(startedAt.getTime() - 14 * 86_400_000)
		: check?.readThrough
			? new Date(check.readThrough.getTime() - 2 * 86_400_000)
			: new Date(startedAt.getTime() - 30 * 86_400_000);
	// What changed since a little before the last full read (TikTok's
	// times are whole seconds, and a message can land while a run reads);
	// older is only reread for a thread whose latest message isn't the one
	// kept.
	const since =
		sweep || !check?.readThrough
			? from
			: new Date(check.readThrough.getTime() - 15 * 60_000);
	const problems: string[] = [];
	let read = 0;
	try {
		const cipher = await shopCipher();
		let token = "";
		do {
			const page = conversationsPage.assert(
				await tiktokApi(BASE, {
					shop_cipher: cipher,
					page_size: "20",
					...(token ? { page_token: token } : {}),
				}),
			);
			const conversations = page.conversations ?? [];
			for (const c of conversations) {
				try {
					if (await syncConversation(db, cipher, c, since, sweep)) read++;
				} catch (error) {
					problems.push(
						`${c.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			// TikTok lists the latest first, though not strictly: stop only
			// once a whole page is before the window.
			const newest = Math.max(
				...conversations.map((c) => c.latest_message?.create_time ?? 0),
			);
			token =
				conversations.length > 0 && newest * 1000 >= from.getTime()
					? (page.next_page_token ?? "")
					: "";
		} while (token);
	} catch (error) {
		problems.unshift(error instanceof Error ? error.message : String(error));
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
		.values({ market: "tiktok", ...set })
		.onConflictDoUpdate({ target: buyerMessageChecks.market, set });
	return { read, problems };
}

// One conversation; false when nothing in it was new.
async function syncConversation(
	db: Db,
	cipher: string,
	c: typeof conversation.infer,
	since: Date,
	sweep: boolean,
) {
	const latest = c.latest_message;
	if (!latest) return false;
	const [thread] = await db
		.select()
		.from(buyerThreads)
		.where(
			and(eq(buyerThreads.market, "tiktok"), eq(buyerThreads.externalId, c.id)),
		);
	if (!sweep) {
		// Unchanged since it was last read in full.
		if (thread?.readLatestId === latest.id) return false;
		// Nothing since the last read, and no buyer had written in it then.
		if (!thread && latest.create_time * 1000 < since.getTime()) return false;
	}
	const messages = await allMessages(cipher, c.id);
	const people = messages.filter(fromPerson);
	if (!thread && !people.some(fromBuyer)) return false;
	const buyer = c.participants?.find((p) => p.role === "BUYER");
	const kept =
		thread ??
		(await ensureThread(db, {
			market: "tiktok",
			externalId: c.id,
			subject: "TikTok Shop chat",
			buyerName: buyer?.nickname ?? null,
			orderRef: orderOf(messages),
		}));
	await keepConversation(db, kept.id, people.map(listed), { apart: true });
	const order = kept.orderRef ? null : orderOf(messages);
	await db
		.update(buyerThreads)
		.set({ readLatestId: latest.id, ...(order ? { orderRef: order } : {}) })
		.where(eq(buyerThreads.id, kept.id));
	return true;
}

// Reads one thread's conversation again, to settle a reply whose send
// didn't say how it went.
export async function rereadTiktokThread(db: Db, threadId: number) {
	const [thread] = await db
		.select()
		.from(buyerThreads)
		.where(eq(buyerThreads.id, threadId));
	if (!thread) return;
	const messages = await allMessages(await shopCipher(), thread.externalId);
	await keepConversation(
		db,
		thread.id,
		messages.filter(fromPerson).map(listed),
		{ apart: true },
	);
}

const sentData = type({ "message_id?": "string", "+": "ignore" });
const uploaded = type({ url: "string", width: "number", height: "number" });

// Sends a reply into a conversation: each picture as a message of its own
// (TikTok's copy, uploaded once and kept on the file), then the words. Each
// message sent is written on the reply as it goes, so reading the
// conversation back never takes one for a second reply. TikTok's message ID
// for the last back. Throws Refused only while nothing has gone; after
// that, or when TikTok may have taken it anyway, Unsure: TikTok has no
// request key, so that's never sent again blind, only looked for
// (rereadTiktokThread).
export async function sendTiktokReply(
	db: Db,
	r: { id: number; conversationId: string; text: string; media: BuyerMedia[] },
) {
	let cipher: string;
	let files: Awaited<ReturnType<typeof replyFileData>>;
	try {
		cipher = await shopCipher();
		files = await replyFileData(db, r.media);
	} catch (error) {
		// Nothing was sent yet.
		throw new Refused(error instanceof Error ? error.message : String(error));
	}
	let sentAny = false;
	// A plain no fails the reply only while nothing of it has gone.
	const stop = (error: unknown, plainNo: boolean): never => {
		const why = error instanceof Error ? error.message : String(error);
		throw plainNo && !sentAny ? new Refused(why) : new Unsure(why);
	};
	const send = async (body: { type: string; content: string }) => {
		let answer: unknown;
		try {
			answer = await tiktokApi(
				`${BASE}/${r.conversationId}/messages`,
				{ shop_cipher: cipher },
				body,
			);
		} catch (error) {
			return stop(error, error instanceof TiktokError && !retryLater(error));
		}
		sentAny = true;
		const id = sentData(answer);
		if (!(id instanceof type.errors) && id.message_id) return id.message_id;
		throw new Unsure(`TikTok took it without an ID: ${JSON.stringify(answer)}`);
	};
	const media = [...r.media];
	let last: string | undefined;
	for (const file of files) {
		let image = file.tiktokImage;
		if (!image) {
			try {
				const form = new FormData();
				form.append(
					"data",
					new Blob([new Uint8Array(file.data)], { type: file.contentType }),
					file.filename,
				);
				image = uploaded.assert(
					await tiktokUpload(
						"/customer_service/202309/images/upload",
						{ shop_cipher: cipher },
						form,
					),
				);
			} catch (error) {
				// An upload sends nothing to the buyer.
				return stop(error, true);
			}
			await db
				.update(buyerReplyFiles)
				.set({ tiktokImage: image })
				.where(eq(buyerReplyFiles.id, file.id));
		}
		last = await send({ type: "IMAGE", content: JSON.stringify(image) });
		const at = media.findIndex((m) => m.fileId === file.id);
		const entry = media[at];
		if (entry) media[at] = { ...entry, externalId: last };
		await db
			.update(buyerMessages)
			.set({ media })
			.where(eq(buyerMessages.id, r.id));
	}
	if (r.text)
		last = await send({
			type: "TEXT",
			content: JSON.stringify({ content: r.text }),
		});
	if (!last) throw new Refused("Nothing to send");
	return last;
}
