import { type } from "arktype";
import { and, eq, isNull } from "drizzle-orm";
import { searchPage, shopCipher, tiktokApi } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import { type BuyerMedia, buyerMessageChecks, buyerThreads } from "#/db/schema";
import { keepConversation, type ListedMessage } from "./conversation";
import { ensureThread, moveThreadOrder } from "./threads";

// TikTok Shop buyer chats through its Customer Service API (202309): every
// conversation with something new since a little before the last full read,
// so a run that failed or ran late leaves no gap. It needs the
// seller.customer_service scope (pnpm tiktok:authorize). TikTok opens a
// conversation for every order and fills it with its own notices (ROBOT and
// SYSTEM), which never count as anyone's; only one a buyer wrote in becomes
// a thread.

const BASE = "/customer_service/202309/conversations";

const sender = type({
	role: "string",
	"nickname?": "string",
	"user_id?": "string",
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

// The buyer's latest order, asked of TikTok: what the conversation is about
// when no card in it says. TikTok's own order card mostly reaches the API as
// OTHER, with no order ID, so most conversations need this; and it doesn't
// depend on katasync having kept the buyer on the order.
async function latestOrderOf(cipher: string, buyerUserId: string) {
	const page = searchPage.assert(
		await tiktokApi(
			"/order/202309/orders/search",
			{
				shop_cipher: cipher,
				page_size: "1",
				sort_field: "create_time",
				sort_order: "DESC",
			},
			{ buyer_user_id: buyerUserId },
		),
	);
	return page.orders?.[0]?.id ?? null;
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
	// Why nothing could be read at all, apart from single conversations.
	let failed: string | undefined;
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
		.values({ market: "tiktok", ...set })
		.onConflictDoUpdate({ target: buyerMessageChecks.market, set });
	return { read, problems, failed };
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
	const buyer = c.participants?.find((p) => p.role === "BUYER");
	// The buyer's latest order, onto a thread no card tied to one.
	const fillOrder = async (threadId: number) => {
		const order = buyer?.user_id
			? await latestOrderOf(cipher, buyer.user_id)
			: null;
		if (order)
			await db
				.update(buyerThreads)
				.set({ orderRef: order })
				.where(
					and(eq(buyerThreads.id, threadId), isNull(buyerThreads.orderRef)),
				);
	};
	if (!sweep) {
		// Unchanged since it was last read in full. One still waiting with no
		// order asks TikTok again, in case the order wasn't findable yet.
		if (thread?.readLatestId === latest.id) {
			if (thread.orderRef === null && thread.doneAt === null)
				await fillOrder(thread.id);
			return false;
		}
		// Nothing since the last read, and no buyer had written in it then.
		if (!thread && latest.create_time * 1000 < since.getTime()) return false;
	}
	const messages = await allMessages(cipher, c.id);
	const people = messages.filter(fromPerson);
	if (!thread && !people.some(fromBuyer)) return false;
	const kept =
		thread ??
		(await ensureThread(db, {
			market: "tiktok",
			externalId: c.id,
			subject: "TikTok Shop chat",
			buyerName: buyer?.nickname ?? null,
			orderRef: orderOf(messages),
		}));
	await keepConversation(db, kept.id, people.map(listed));
	// TikTok keeps one conversation a buyer: a later card about another of
	// their orders moves the thread to it.
	const order = orderOf(messages);
	if (order) await moveThreadOrder(db, kept.id, order);
	// Before it counts as read, so a failed ask is made again next run.
	else if (!kept.orderRef) await fillOrder(kept.id);
	await db
		.update(buyerThreads)
		.set({ readLatestId: latest.id })
		.where(eq(buyerThreads.id, kept.id));
	return true;
}
