import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { buyerMessages, buyerThreads, marketEmails } from "#/db/schema";
import {
	amazonReplyStatus,
	applyAmazonRefusals,
	sendAmazonReply,
} from "./amazon-mail";
import {
	EBAY_MAX_CHARS,
	rereadEbayThread,
	sendEbayMessage,
} from "./ebay-messages";
import { settleReply, Unsure, unsettledReplies } from "./states";

// Answering a buyer from katasync. The reply is kept before anything is
// sent, so whatever happens next (a crash, a timeout) leaves it sending,
// never lost; settleReplies then finds out how it went. An Amazon reply is
// tried again with the same request key, which Resend sends once; an eBay
// one is never sent twice, only looked for in the conversation.

// Resend keeps a request key a day; past that a retry could send it twice.
const RETRY_FOR_MS = 23 * 3_600_000;
// How long an unsure eBay reply is looked for before it counts as not sent.
const LOOK_FOR_MS = 15 * 60_000;

type Thread = typeof buyerThreads.$inferSelect;
type Reply = typeof buyerMessages.$inferSelect;

export async function reply(db: Db, threadId: number, text: string) {
	const body = text.trim();
	if (!body) throw new Error("Write something first");
	const [thread] = await db
		.select()
		.from(buyerThreads)
		.where(eq(buyerThreads.id, threadId));
	if (!thread) throw new Error(`There's no buyer thread ${threadId}`);
	if (thread.market !== "amazon" && thread.market !== "ebay")
		throw new Error(`katasync can't answer ${thread.market} buyers yet`);
	if (thread.market === "ebay" && body.length > EBAY_MAX_CHARS)
		throw new Error(`eBay takes up to ${EBAY_MAX_CHARS} characters`);
	const now = new Date();
	const [row] = await db
		.insert(buyerMessages)
		.values({
			threadId,
			fromBuyer: false,
			body,
			at: now,
			status: "sending",
			requestKey: randomUUID(),
			statusAt: now,
		})
		.returning();
	if (!row) throw new Error("The reply wasn't kept");
	// Answered is done with, unless the buyer writes again.
	await db
		.update(buyerThreads)
		.set({ doneAt: null })
		.where(eq(buyerThreads.id, threadId));
	await attempt(db, thread, row);
	const [settled] = await db
		.select({ id: buyerMessages.id, status: buyerMessages.status })
		.from(buyerMessages)
		.where(eq(buyerMessages.id, row.id));
	return settled ?? { id: row.id, status: row.status };
}

// One try at sending a reply that's sending. An unsure outcome leaves it so.
async function attempt(db: Db, thread: Thread, r: Reply) {
	try {
		if (thread.market === "amazon") {
			const id = await sendAmazonReply({
				to: thread.externalId,
				subject: thread.subject,
				inReplyTo: await lastBuyerEmailId(db, thread.id),
				text: r.body,
				requestKey: r.requestKey ?? r.id.toString(),
			});
			await settleReply(db, r.id, { kind: "accepted", externalId: id });
		} else {
			const id = await sendEbayMessage(thread.externalId, r.body);
			await settleReply(db, r.id, { kind: "delivered", externalId: id });
		}
	} catch (error) {
		if (error instanceof Unsure) return;
		await settleReply(db, r.id, {
			kind: "failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// The Message-ID of the buyer's latest email, so the reply threads under it.
async function lastBuyerEmailId(db: Db, threadId: number) {
	const [row] = await db
		.select({ messageId: marketEmails.messageId })
		.from(buyerMessages)
		.innerJoin(marketEmails, eq(marketEmails.id, buyerMessages.marketEmailId))
		.where(
			and(
				eq(buyerMessages.threadId, threadId),
				isNotNull(buyerMessages.marketEmailId),
			),
		)
		.orderBy(desc(buyerMessages.at))
		.limit(1);
	return row?.messageId ?? null;
}

// Settles every reply still in flight. Run by the cron; safe to run twice at
// once, since each change only applies from the state before it.
export async function settleReplies(db: Db, now = Date.now()) {
	const open = await unsettledReplies(db);
	const threads = new Map<number, Thread>();
	const problems: string[] = [];
	const reread = new Set<number>();
	for (const r of open) {
		// Still with the request that's sending it.
		if (r.status === "sending" && now - (r.statusAt?.getTime() ?? 0) < 60_000)
			continue;
		let thread = threads.get(r.threadId);
		if (!thread) {
			[thread] = await db
				.select()
				.from(buyerThreads)
				.where(eq(buyerThreads.id, r.threadId));
			if (!thread) continue;
			threads.set(thread.id, thread);
		}
		const age = now - r.at.getTime();
		try {
			if (thread.market === "amazon" && r.status === "sending") {
				if (age < RETRY_FOR_MS) await attempt(db, thread, r);
				else
					await settleReply(db, r.id, {
						kind: "lost",
						error: "Resend never confirmed it. Send it again",
					});
			} else if (thread.market === "amazon" && r.externalId) {
				const s = await amazonReplyStatus(r.externalId);
				if (s.state !== "going")
					await settleReply(
						db,
						r.id,
						s.state === "delivered"
							? { kind: "delivered" }
							: { kind: "failed", error: s.error },
					);
			} else if (thread.market === "ebay") {
				if (!reread.has(thread.id)) {
					reread.add(thread.id);
					await rereadEbayThread(db, thread.id);
				}
				if (age > LOOK_FOR_MS)
					// Lost only from sending: a reply the reread found stays.
					await settleReply(db, r.id, {
						kind: "lost",
						error: "eBay didn't take it. Send it again",
					});
			}
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	const refused = await applyAmazonRefusals(db);
	return { open: open.length, refused, problems };
}
