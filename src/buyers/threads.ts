import { randomUUID } from "node:crypto";
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type BuyerMedia,
	buyerMessageChecks,
	buyerMessages,
	buyerThreads,
	mailboxChecks,
	orders,
	replyDrafts,
	replyPrecedents,
	stores,
} from "#/db/schema";
import type { Market } from "#/markets/market";
import { marketplaceMessagesOf } from "./marketplace-messages";
import { answers, type ReplyStatus } from "./states";
import { isThreadOrder } from "./thread-order";

// Conversations with buyers, as katasync keeps them: read in from each
// marketplace (./amazon-mail.ts, ./ebay-messages.ts,
// ./tiktok-messages.ts), answered from the
// Inbox (./send.ts). Server only.

// How long each marketplace gives to answer a buyer. Amazon counts 24 hours,
// weekends too; TikTok Shop 12. eBay sets none, so we hold to a day.
export const REPLY_WITHIN_MS: Record<Market, number> = {
	amazon: 24 * 3_600_000,
	ebay: 24 * 3_600_000,
	tiktok: 12 * 3_600_000,
	shopify: 24 * 3_600_000,
};

export type ThreadKey = {
	market: Market;
	externalId: string;
	subject: string;
	buyerName?: string | null;
	orderRef?: string | null;
	itemRef?: string | null;
};

// The thread, made the first time it's seen. What it's about fills in when a
// later message names it.
export async function ensureThread(db: Db, t: ThreadKey) {
	const [row] = await db
		.insert(buyerThreads)
		.values({
			market: t.market,
			externalId: t.externalId,
			subject: t.subject,
			buyerName: t.buyerName ?? null,
			orderRef: t.orderRef ?? null,
			itemRef: t.itemRef ?? null,
		})
		.onConflictDoNothing()
		.returning();
	if (row) return row;
	const [found] = await db
		.select()
		.from(buyerThreads)
		.where(
			and(
				eq(buyerThreads.market, t.market),
				eq(buyerThreads.externalId, t.externalId),
			),
		);
	if (!found) throw new Error(`Thread ${t.externalId} vanished`);
	const fill = {
		...(found.buyerName === null && t.buyerName
			? { buyerName: t.buyerName }
			: {}),
		...(found.orderRef === null && t.orderRef ? { orderRef: t.orderRef } : {}),
		...(found.itemRef === null && t.itemRef ? { itemRef: t.itemRef } : {}),
	};
	if (Object.keys(fill).length === 0) return found;
	const [filled] = await db
		.update(buyerThreads)
		.set(fill)
		.where(eq(buyerThreads.id, found.id))
		.returning();
	return filled ?? found;
}

// The thread is about another order now: a later card in its conversation
// names it. A suggestion kept for the thread's own order stays with the one
// it was written about, so it's drafted again for the new one; one written
// about the new one is the thread's own now.
export async function moveThreadOrder(db: Db, threadId: number, to: string) {
	await db.transaction(async (tx) => {
		const [t] = await tx
			.select({ orderRef: buyerThreads.orderRef })
			.from(buyerThreads)
			.where(eq(buyerThreads.id, threadId))
			.for("update");
		if (!t || t.orderRef === to) return;
		if (t.orderRef !== null)
			await tx
				.update(replyDrafts)
				.set({
					orderRef: sql`case when ${replyDrafts.orderRef} is null then ${t.orderRef}::text when ${replyDrafts.orderRef} = ${to} then null else ${replyDrafts.orderRef} end`,
				})
				.where(eq(replyDrafts.threadId, threadId));
		await tx
			.update(buyerThreads)
			.set({ orderRef: to })
			.where(eq(buyerThreads.id, threadId));
	});
}

// A buyer's message; false when it was already kept. A new one opens a
// thread someone was done with.
export async function recordFromBuyer(
	db: Db,
	threadId: number,
	m: {
		externalId: string;
		body: string;
		at: Date;
		marketEmailId?: number;
		media?: BuyerMedia[];
	},
) {
	const media = m.media ?? [];
	const [row] = await db
		.insert(buyerMessages)
		.values({
			threadId,
			fromBuyer: true,
			externalId: m.externalId,
			body: m.body,
			at: m.at,
			marketEmailId: m.marketEmailId ?? null,
			media,
		})
		.onConflictDoNothing()
		.returning({ id: buyerMessages.id });
	if (!row) {
		// Kept before its pictures were: they're added now.
		if (media.length > 0)
			await db
				.update(buyerMessages)
				.set({ media })
				.where(
					and(
						eq(buyerMessages.threadId, threadId),
						eq(buyerMessages.externalId, m.externalId),
						sql`${buyerMessages.media} = '[]'::jsonb`,
					),
				);
		return false;
	}
	await db
		.update(buyerThreads)
		.set({ doneAt: null })
		.where(eq(buyerThreads.id, threadId));
	return true;
}

// A message of ours sent outside katasync (on the marketplace's own site),
// so the thread shows it answered. False when it was already kept.
export async function recordOurs(
	db: Db,
	threadId: number,
	m: {
		externalId: string;
		body: string;
		at: Date;
		media?: BuyerMedia[];
		marketEmailId?: number;
	},
) {
	const [row] = await db
		.insert(buyerMessages)
		.values({
			threadId,
			fromBuyer: false,
			externalId: m.externalId,
			body: m.body,
			at: m.at,
			media: m.media ?? [],
			marketEmailId: m.marketEmailId,
			status: "delivered",
			requestKey: randomUUID(),
			statusAt: m.at,
		})
		.onConflictDoNothing()
		.returning({ id: buyerMessages.id });
	return row !== undefined;
}

// What a reply staff added without sending carries for its ID until the
// marketplace's own turns up (eBay reads it back; Amazon never does).
export const LOGGED = "logged:";
export const isLogged = (externalId: string | null) =>
	externalId?.startsWith(LOGGED) ?? false;

// A reply staff sent on the marketplace itself, added so the thread shows
// it answered. Nothing is sent. The same key twice is one message.
export async function logOurs(
	db: Db,
	threadId: number,
	body: string,
	requestKey: string,
) {
	const words = body.trim();
	if (!words) throw new Error("Write something first");
	const now = new Date();
	const [row] = await db
		.insert(buyerMessages)
		.values({
			threadId,
			fromBuyer: false,
			externalId: `${LOGGED}${requestKey}`,
			body: words,
			at: now,
			status: "delivered",
			requestKey,
			statusAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: buyerMessages.id });
	await db.delete(replyDrafts).where(eq(replyDrafts.threadId, threadId));
	return row ?? null;
}

// Takes back one added without sending; one sent through katasync can't be.
export async function unlogOurs(db: Db, requestKey: string) {
	await db
		.delete(buyerMessages)
		.where(
			and(
				eq(buyerMessages.requestKey, requestKey),
				eq(buyerMessages.externalId, `${LOGGED}${requestKey}`),
			),
		);
}

// Someone was done with it, or wasn't after all.
export async function setThreadDone(db: Db, id: number, done: boolean) {
	const [row] = await db
		.update(buyerThreads)
		.set({ doneAt: done ? new Date() : null })
		.where(eq(buyerThreads.id, id))
		.returning({ id: buyerThreads.id });
	if (!row) throw new Error(`There's no buyer thread ${id}`);
	return row;
}

type Message = {
	id: number;
	fromBuyer: boolean;
	body: string;
	at: Date;
	status: ReplyStatus | null;
	error: string | null;
};

// Whether a thread waits on us, and since when: the buyer's messages after
// our last reply that didn't fail. Due is when the marketplace's clock runs
// out, counted from the first of those.
export function waitingOn(
	market: Market,
	messages: Pick<Message, "fromBuyer" | "at" | "status">[],
) {
	const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
	let since: Date | null = null;
	for (const m of sorted) {
		if (m.fromBuyer) since ??= m.at;
		else if (answers(m.status)) since = null;
	}
	return since
		? { since, due: new Date(since.getTime() + REPLY_WITHIN_MS[market]) }
		: null;
}

// The threads of a view, those waiting first, soonest due first; then the
// rest, latest first. Each with its messages, oldest first. Every open one,
// so none waiting is ever cut off; done ones, the latest done. Or just one,
// open or done.
export async function threadsPage(
	db: Db,
	view: "open" | "done" | { id: number },
	market: Market | null,
	limit = 200,
) {
	const query = db
		.select({
			id: buyerThreads.id,
			market: buyerThreads.market,
			buyerName: buyerThreads.buyerName,
			subject: buyerThreads.subject,
			orderRef: buyerThreads.orderRef,
			itemRef: buyerThreads.itemRef,
			doneAt: buyerThreads.doneAt,
			orderId: orders.id,
			orderName: orders.name,
		})
		.from(buyerThreads)
		.leftJoin(
			stores,
			and(
				eq(stores.channel, buyerThreads.market),
				isNotNull(buyerThreads.orderRef),
			),
		)
		.leftJoin(orders, isThreadOrder(buyerThreads.market, buyerThreads.orderRef))
		.where(
			and(
				typeof view === "object"
					? eq(buyerThreads.id, view.id)
					: view === "done"
						? isNotNull(buyerThreads.doneAt)
						: isNull(buyerThreads.doneAt),
				market ? eq(buyerThreads.market, market) : undefined,
			),
		)
		.orderBy(desc(buyerThreads.doneAt), desc(buyerThreads.id))
		.$dynamic();
	const threads = await (view === "done" ? query.limit(limit) : query);
	// A thread whose order is in two stores of a channel would show twice.
	const unique = [...new Map(threads.map((t) => [t.id, t])).values()];
	const messages =
		unique.length === 0
			? []
			: await db
					.select({
						id: buyerMessages.id,
						threadId: buyerMessages.threadId,
						fromBuyer: buyerMessages.fromBuyer,
						body: buyerMessages.body,
						at: buyerMessages.at,
						status: buyerMessages.status,
						error: buyerMessages.error,
						requestKey: buyerMessages.requestKey,
						externalId: buyerMessages.externalId,
						media: buyerMessages.media,
						language: buyerMessages.language,
						english: buyerMessages.english,
					})
					.from(buyerMessages)
					.where(
						inArray(
							buyerMessages.threadId,
							unique.map((t) => t.id),
						),
					)
					.orderBy(asc(buyerMessages.at), asc(buyerMessages.id));
	const [drafts, precedents, marketplace] =
		unique.length === 0
			? [[], [], []]
			: await Promise.all([
					db
						.select()
						.from(replyDrafts)
						.where(
							inArray(
								replyDrafts.threadId,
								unique.map((t) => t.id),
							),
						),
					db
						.select({ id: replyPrecedents.id, name: replyPrecedents.name })
						.from(replyPrecedents),
					marketplaceMessagesOf(
						db,
						unique.map((t) => t.id),
					),
				]);
	const shaped = unique.map((t) => {
		const own = messages
			.filter((m) => m.threadId === t.id)
			.map(({ threadId: _, externalId, ...m }) => ({
				...m,
				// Added by staff without katasync sending it.
				logged: isLogged(externalId),
			}));
		const last = own.at(-1);
		const latestTheirs = own.filter((m) => m.fromBuyer).at(-1);
		const d = drafts.find((x) => x.threadId === t.id);
		return {
			...t,
			messages: own,
			// The marketplace's own, shown with them; never counted as either
			// side's.
			marketplace: marketplace.filter((m) => m.threadId === t.id),
			lastAt: last?.at ?? null,
			waiting: t.doneAt ? null : waitingOn(t.market, own),
			// The buyer's language, from their latest message read.
			language:
				own.filter((m) => m.fromBuyer && m.language).at(-1)?.language ?? null,
			draft: d
				? {
						state: d.state,
						body: d.body,
						english: d.english,
						note: d.note,
						by: d.by,
						error: d.error,
						updatedAt: d.updatedAt,
						// The order it was written about (null: none).
						forOrder: d.orderRef ?? t.orderRef,
						// Written before the buyer's latest message.
						stale:
							latestTheirs !== undefined &&
							(d.forMessageId ?? 0) < latestTheirs.id,
						precedents: precedents.filter((p) => d.precedentIds.includes(p.id)),
					}
				: null,
		};
	});
	return shaped.sort((a, b) => {
		if (a.waiting && b.waiting)
			return a.waiting.due.getTime() - b.waiting.due.getTime();
		if (a.waiting || b.waiting) return a.waiting ? -1 : 1;
		return (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0);
	});
}

export type BuyerThread = Awaited<ReturnType<typeof threadsPage>>[number];

// Threads waiting on a reply, for the side list.
export async function countWaiting(db: Db, market: Market | null) {
	const open = await threadsPage(db, "open", market);
	return open.filter((t) => t.waiting).length;
}

// Behind when a source hasn't been read this long. The messages cron runs
// every five minutes. The mailbox records a read only when there's new mail
// or on its sweep, every four hours, so a quiet mailbox is behind only past
// that.
const RUN_STALE_MS = 20 * 60_000;
const MAILBOX_STALE_MS = 4.5 * 3_600_000;

// When each source of buyer messages was last read in full, the error when
// the latest try failed, and whether it's behind. Amazon's needs both the
// marketplaces mailbox read and its emails put in threads.
export async function messageSources(db: Db, now = Date.now()) {
	const [mailbox, checks] = await Promise.all([
		db
			.select()
			.from(mailboxChecks)
			.where(eq(mailboxChecks.mailbox, "marketplaces")),
		db.select().from(buyerMessageChecks),
	]);
	const of = (m: Market) => checks.find((c) => c.market === m);
	const box = mailbox[0];
	const amazon = of("amazon");
	const ebay = of("ebay");
	const tiktok = of("tiktok");
	const stale = (at: Date | null | undefined, ms: number) =>
		!at || now - at.getTime() > ms;
	return [
		{
			market: "amazon" as const,
			checkedAt: amazon?.checkedAt ?? null,
			error: box?.error ?? amazon?.error ?? null,
			behind:
				stale(amazon?.checkedAt, RUN_STALE_MS) ||
				stale(box?.checkedAt, MAILBOX_STALE_MS),
		},
		{
			market: "ebay" as const,
			checkedAt: ebay?.checkedAt ?? null,
			error: ebay?.error ?? null,
			behind: stale(ebay?.checkedAt, RUN_STALE_MS),
		},
		{
			market: "tiktok" as const,
			checkedAt: tiktok?.checkedAt ?? null,
			error: tiktok?.error ?? null,
			behind: stale(tiktok?.checkedAt, RUN_STALE_MS),
		},
	];
}

export type MessageSource = Awaited<ReturnType<typeof messageSources>>[number];
