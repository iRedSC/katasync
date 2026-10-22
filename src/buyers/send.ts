import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { buyerMessages, buyerThreads, marketEmails } from "#/db/schema";
import {
	amazonReplyStatus,
	applyAmazonRefusals,
	sendAmazonReply,
} from "./amazon-mail";
import { clearDraft } from "./drafts";
import {
	EBAY_MAX_CHARS,
	rereadEbayThread,
	sendEbayMessage,
} from "./ebay-messages";
import { Refused, settleReply, unsettledReplies } from "./states";

// Answering a buyer from katasync. The reply is kept, with everything it
// will send, before anything is sent, so whatever happens next (a crash, a
// timeout, the browser losing the answer) leaves it sending, never lost;
// settleReplies then finds out how it went. The browser names each reply
// with its own key, so sending it again after a lost answer is the same
// reply, not a second. An Amazon reply is tried again with that key, which
// Resend sends once; an eBay one is never sent twice, only looked for in the
// conversation. When neither can tell, it's unconfirmed, never failed.

// Resend keeps a request key a day; past that a retry could send it twice.
const RETRY_FOR_MS = 23 * 3_600_000;
// How long an unsure eBay reply is looked for before it's unconfirmed.
const LOOK_FOR_MS = 15 * 60_000;

type Thread = typeof buyerThreads.$inferSelect;
type Reply = typeof buyerMessages.$inferSelect;

export async function reply(
	db: Db,
	threadId: number,
	text: string,
	requestKey: string,
) {
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
			requestKey,
			statusAt: now,
			inReplyTo:
				thread.market === "amazon"
					? await lastBuyerEmailId(db, thread.id)
					: null,
		})
		// Sent before and its answer lost: the same reply, left to settle.
		.onConflictDoNothing()
		.returning();
	if (row) {
		// Answered is done with, unless the buyer writes again.
		await db
			.update(buyerThreads)
			.set({ doneAt: null })
			.where(eq(buyerThreads.id, threadId));
		// The suggestion is used up: a reply went instead.
		await clearDraft(db, threadId);
		await attempt(db, thread, row);
	}
	const [now_] = await db
		.select({ id: buyerMessages.id, status: buyerMessages.status })
		.from(buyerMessages)
		.where(
			and(
				eq(buyerMessages.requestKey, requestKey),
				eq(buyerMessages.threadId, threadId),
			),
		);
	if (!now_) throw new Error("That key belongs to another conversation");
	return now_;
}

// One try at sending a reply that's sending. Only a plain no fails it;
// anything else (no answer, an answer that didn't read, the database
// failing after the send) leaves it sending for settleReplies.
async function attempt(db: Db, thread: Thread, r: Reply) {
	let outcome:
		| { kind: "accepted" | "delivered"; externalId: string }
		| { kind: "failed"; error: string }
		| null = null;
	try {
		outcome =
			thread.market === "amazon"
				? {
						kind: "accepted",
						externalId: await sendAmazonReply({
							to: thread.externalId,
							subject: thread.subject,
							inReplyTo: r.inReplyTo,
							text: r.body,
							requestKey: r.requestKey ?? r.id.toString(),
						}),
					}
				: {
						kind: "delivered",
						externalId: await sendEbayMessage(thread.externalId, r.body),
					};
	} catch (error) {
		if (error instanceof Refused)
			outcome = { kind: "failed", error: error.message };
	}
	if (outcome) await settleReply(db, r.id, outcome).catch(() => false);
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
	const open = await unsettledReplies(db, new Date(now));
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
			if (thread.market === "amazon") await settleAmazon(db, thread, r, age);
			else if (thread.market === "ebay") {
				if (!reread.has(thread.id)) {
					reread.add(thread.id);
					// Looked for; failing to look still lets it go unconfirmed.
					await rereadEbayThread(db, thread.id).catch((e: unknown) =>
						problems.push(e instanceof Error ? e.message : String(e)),
					);
				}
				if (r.status === "sending" && age > LOOK_FOR_MS)
					// Only from sending: a reply the reread found stays found.
					await settleReply(db, r.id, {
						kind: "unconfirmed",
						error:
							"eBay never said whether it went. Check the conversation on eBay before sending it again",
					});
			}
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	const refused = await applyAmazonRefusals(db);
	return { open: open.length, refused, problems };
}

async function settleAmazon(db: Db, thread: Thread, r: Reply, age: number) {
	if (r.status === "sending") {
		if (age < RETRY_FOR_MS) return attempt(db, thread, r);
		return settleReply(db, r.id, {
			kind: "unconfirmed",
			error:
				"Resend never said whether it went. Check the messages in Seller Central before sending it again",
		});
	}
	// Sent: ask Resend how far it got. Unconfirmed has nothing to ask about.
	if (r.status !== "sent" || !r.externalId) return;
	const s = await amazonReplyStatus(r.externalId);
	if (s.state === "delivered")
		await settleReply(db, r.id, { kind: "delivered" });
	if (s.state === "failed")
		await settleReply(db, r.id, { kind: "failed", error: s.error });
}
