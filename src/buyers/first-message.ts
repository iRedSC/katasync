import { and, desc, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { buyerChatStarts } from "#/db/schema";
import { refuseWords } from "./attachments";
import { chatOrder, isEbay } from "./chat-order";
import { attemptOutcome, type FirstMessage, type LastTry } from "./chat-way";
import {
	ebayOrderBuyer,
	keepEbayConversationWith,
	sendEbayMessage,
} from "./ebay-messages";
import { Refused } from "./states";

// The first message to an eBay buyer, which is what starts the
// conversation. eBay has no request key, so each try is written down under
// the browser's key before eBay is asked (buyer_chat_starts): the same key
// again, at once or after a lost answer, reads that try back and never
// sends a second. One that may have gone stays unsure, shown again when
// the order's chat is reopened; sending anyway is a new try with a new
// key. Server only.

const why = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// A send that didn't come back with an ID. Only a plain no means it didn't
// go; anything else may have.
export function firstMessageFailure(
	error: unknown,
): Extract<FirstMessage, { kind: "refused" | "unsure" }> {
	return error instanceof Refused
		? { kind: "refused", reason: error.message }
		: {
				kind: "unsure",
				reason: `eBay didn't say whether it went (${why(error)}). Check eBay Messages before sending again`,
			};
}

type Settled = Exclude<FirstMessage, { kind: "sending" }>;

// Moves a try on from sending, and only from sending, so a late or
// repeated answer changes nothing.
async function settle(
	db: Db,
	id: number,
	outcome: Settled,
	messageId?: string,
) {
	await db
		.update(buyerChatStarts)
		.set({
			status:
				outcome.kind === "sent" || outcome.kind === "sent_unlisted"
					? "sent"
					: outcome.kind,
			messageId: messageId ?? null,
			threadId: outcome.kind === "sent" ? outcome.threadId : null,
			error: "reason" in outcome ? outcome.reason : null,
			statusAt: new Date(),
		})
		.where(
			and(eq(buyerChatStarts.id, id), eq(buyerChatStarts.status, "sending")),
		);
	return outcome;
}

export async function firstEbayMessage(
	db: Db,
	orderId: number,
	text: string,
	requestKey: string,
): Promise<FirstMessage> {
	const o = await chatOrder(db, orderId);
	if (!isEbay(o))
		return { kind: "refused", reason: "This order's buyer isn't on eBay" };
	const body = text.trim();
	if (!body) return { kind: "refused", reason: "Write something first" };
	const tooLong = refuseWords("ebay", body);
	if (tooLong) return { kind: "refused", reason: tooLong };
	const [mine] = await db
		.insert(buyerChatStarts)
		.values({ requestKey, orderId, body })
		.onConflictDoNothing()
		.returning();
	if (!mine) {
		// Sent with this key before: how that went, never a second send.
		const [before] = await db
			.select()
			.from(buyerChatStarts)
			.where(eq(buyerChatStarts.requestKey, requestKey));
		if (!before || before.orderId !== orderId)
			throw new Error("That key belongs to another order");
		return attemptOutcome(before, new Date());
	}
	let to: Awaited<ReturnType<typeof ebayOrderBuyer>>;
	try {
		to = await ebayOrderBuyer(o.externalId);
	} catch (error) {
		// Nothing was sent yet.
		return settle(db, mine.id, { kind: "refused", reason: why(error) });
	}
	const username = to.username;
	if (!username)
		return settle(db, mine.id, {
			kind: "refused",
			reason: "eBay didn't say who the buyer is",
		});
	let messageId: string;
	try {
		messageId = await sendEbayMessage({ username, itemId: to.itemId }, body);
	} catch (error) {
		return settle(db, mine.id, firstMessageFailure(error));
	}
	const thread = await keepEbayConversationWith(
		db,
		{ username, itemId: to.itemId, orderRef: o.externalId },
		messageId,
	).catch(() => null);
	return settle(
		db,
		mine.id,
		thread ? { kind: "sent", threadId: thread.id } : { kind: "sent_unlisted" },
		messageId,
	);
}

// The order's latest try, unless it plainly didn't go: what the page shows
// when its chat opens again.
export async function lastTry(
	db: Db,
	orderId: number,
): Promise<LastTry | null> {
	const [latest] = await db
		.select()
		.from(buyerChatStarts)
		.where(eq(buyerChatStarts.orderId, orderId))
		.orderBy(desc(buyerChatStarts.createdAt), desc(buyerChatStarts.id))
		.limit(1);
	if (!latest) return null;
	const outcome = attemptOutcome(latest, new Date());
	return outcome.kind === "refused" ? null : { body: latest.body, outcome };
}
