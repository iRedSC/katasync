import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	buyerMessageChecks,
	buyerMessages,
	buyerThreads,
	mailboxChecks,
	orders,
	stores,
} from "#/db/schema";
import type { Market } from "#/markets/market";
import type { ReplyStatus } from "./states";

// Conversations with buyers, as katasync keeps them: read in from each
// marketplace (./amazon-mail.ts, ./ebay-messages.ts), answered from the
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

// A buyer's message; false when it was already kept. A new one opens a
// thread someone was done with.
export async function recordFromBuyer(
	db: Db,
	threadId: number,
	m: { externalId: string; body: string; at: Date; marketEmailId?: number },
) {
	const [row] = await db
		.insert(buyerMessages)
		.values({
			threadId,
			fromBuyer: true,
			externalId: m.externalId,
			body: m.body,
			at: m.at,
			marketEmailId: m.marketEmailId ?? null,
		})
		.onConflictDoNothing()
		.returning({ id: buyerMessages.id });
	if (!row) return false;
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
	m: { externalId: string; body: string; at: Date },
) {
	const [row] = await db
		.insert(buyerMessages)
		.values({
			threadId,
			fromBuyer: false,
			externalId: m.externalId,
			body: m.body,
			at: m.at,
			status: "delivered",
			requestKey: randomUUID(),
			statusAt: m.at,
		})
		.onConflictDoNothing()
		.returning({ id: buyerMessages.id });
	return row !== undefined;
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
		else if (m.status !== "failed") since = null;
	}
	return since
		? { since, due: new Date(since.getTime() + REPLY_WITHIN_MS[market]) }
		: null;
}

// The threads of a view, those waiting first, soonest due first; then the
// rest, latest first. Each with its messages, oldest first.
export async function threadsPage(
	db: Db,
	view: "open" | "done",
	market: Market | null,
	limit = 200,
) {
	const threads = await db
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
		.leftJoin(
			orders,
			and(
				eq(orders.storeId, stores.id),
				eq(orders.externalId, buyerThreads.orderRef),
			),
		)
		.where(
			and(
				view === "done"
					? isNotNull(buyerThreads.doneAt)
					: isNull(buyerThreads.doneAt),
				market ? eq(buyerThreads.market, market) : undefined,
			),
		)
		.orderBy(desc(buyerThreads.id))
		.limit(limit);
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
					})
					.from(buyerMessages)
					.where(
						inArray(
							buyerMessages.threadId,
							unique.map((t) => t.id),
						),
					)
					.orderBy(asc(buyerMessages.at), asc(buyerMessages.id));
	const shaped = unique.map((t) => {
		const own = messages
			.filter((m) => m.threadId === t.id)
			.map(({ threadId: _, ...m }) => m);
		const last = own.at(-1);
		return {
			...t,
			messages: own,
			lastAt: last?.at ?? null,
			waiting: t.doneAt ? null : waitingOn(t.market, own),
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

// When each source of buyer messages was last read in full, and the error
// when the latest try failed. Amazon's needs both the marketplaces mailbox
// read and its emails put in threads.
export async function messageSources(db: Db) {
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
	const older = (a: Date | null | undefined, b: Date | null | undefined) =>
		a && b ? (a < b ? a : b) : null;
	return [
		{
			market: "amazon" as const,
			checkedAt: older(box?.checkedAt, amazon?.checkedAt),
			error: box?.error ?? amazon?.error ?? null,
		},
		{
			market: "ebay" as const,
			checkedAt: ebay?.checkedAt ?? null,
			error: ebay?.error ?? null,
		},
	];
}

export type MessageSource = Awaited<ReturnType<typeof messageSources>>[number];
