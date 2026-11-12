import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type BuyerMedia,
	buyerMessageChecks,
	buyerMessages,
	buyerThreads,
	mailboxChecks,
} from "#/db/schema";
import type { Market } from "#/markets/market";
import { ANSWERING } from "./states";

// Conversations with buyers, as katasync keeps them: read in from each
// marketplace (./amazon-mail.ts, ./ebay-messages.ts, ./tiktok-messages.ts)
// only to count those waiting on us. They're read and answered on the
// marketplaces themselves. Server only.

// The marketplaces whose buyer messages are read, in the order shown.
export const MESSAGE_MARKETS = ["amazon", "ebay", "tiktok"] as const;
export type MessageMarket = (typeof MESSAGE_MARKETS)[number];

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
// names it.
export async function moveThreadOrder(db: Db, threadId: number, to: string) {
	await db
		.update(buyerThreads)
		.set({ orderRef: to })
		.where(eq(buyerThreads.id, threadId));
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

// Whether an open thread waits on us, worked out in the database: a
// buyer's message with no reply of ours after it that answers (time, then
// ID). Every column is named with its table: Drizzle leaves them bare in a
// query of one table, where the inner ones would name themselves.
function waitingOnUs() {
	const of = (table: string, column: string) =>
		sql`${sql.identifier(table)}.${sql.identifier(column)}`;
	const m = (c: string) => of("waiting_theirs", c);
	const o = (c: string) => of("waiting_ours", c);
	const answering = sql.join(
		ANSWERING.map((s) => sql`${s}`),
		sql`, `,
	);
	return sql`exists (
		select 1 from ${buyerMessages} as ${sql.identifier("waiting_theirs")}
		where ${m("thread_id")} = ${of("buyer_threads", "id")} and ${m("from_buyer")}
		and not exists (
			select 1 from ${buyerMessages} as ${sql.identifier("waiting_ours")}
			where ${o("thread_id")} = ${m("thread_id")} and not ${o("from_buyer")}
			and ${o("status")} in (${answering})
			and (${o("at")}, ${o("id")}) > (${m("at")}, ${m("id")})
		)
	)`;
}

// Open threads waiting on a reply, by marketplace; zero where none are.
export async function countWaitingByMarket(
	db: Db,
): Promise<Record<MessageMarket, number>> {
	const rows = await db
		.select({ market: buyerThreads.market, n: count() })
		.from(buyerThreads)
		.where(
			and(
				isNull(buyerThreads.doneAt),
				inArray(buyerThreads.market, [...MESSAGE_MARKETS]),
				waitingOnUs(),
			),
		)
		.groupBy(buyerThreads.market);
	const n = (m: MessageMarket) => rows.find((r) => r.market === m)?.n ?? 0;
	return { amazon: n("amazon"), ebay: n("ebay"), tiktok: n("tiktok") };
}

// Takes every thread waiting on us in a marketplace out of its count, for
// what needs no answer (a buyer's "thanks"). The ones taken, so it can be
// undone. A new message from the buyer counts one again.
export async function clearWaiting(db: Db, market: MessageMarket) {
	const rows = await db
		.update(buyerThreads)
		.set({ doneAt: new Date() })
		.where(
			and(
				isNull(buyerThreads.doneAt),
				eq(buyerThreads.market, market),
				waitingOnUs(),
			),
		)
		.returning({ id: buyerThreads.id });
	return rows.map((r) => r.id);
}

// Counts cleared threads again: clearWaiting undone.
export async function unclearThreads(db: Db, ids: number[]) {
	if (ids.length === 0) return;
	await db
		.update(buyerThreads)
		.set({ doneAt: null })
		.where(inArray(buyerThreads.id, ids));
}

// Threads waiting on a reply in one marketplace, or all of them.
export async function countWaiting(db: Db, market: Market | null) {
	const by = await countWaitingByMarket(db);
	if (market === null) return MESSAGE_MARKETS.reduce((n, m) => n + by[m], 0);
	return isMessageMarket(market) ? by[market] : 0;
}

export const isMessageMarket = (m: Market): m is MessageMarket =>
	(MESSAGE_MARKETS as readonly Market[]).includes(m);

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
