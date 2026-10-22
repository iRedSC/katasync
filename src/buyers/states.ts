import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { buyerMessages, type buyerReplyStatus } from "#/db/schema";

// Where a reply we wrote stands, and the only way it moves on. Every write to
// a reply's status goes through settleReply, which updates only from the
// states its event may follow, so a late or repeated event (a cron finding
// what the send already recorded, two runs at once) changes nothing.
//
//   sending ──accepted──▶ sent ──delivered──▶ delivered
//      │  └──delivered (eBay)──────────────────▶ │
//      ├──failed──▶ failed ◀──refused── sent or delivered (Amazon, later)
//      └──unconfirmed──▶ unconfirmed ──delivered (found after all)──▶ delivered
//
// failed means it didn't go: sending it again is a new reply. unconfirmed
// means no one can tell, so it's never called failed on a guess.

export type ReplyStatus = (typeof buyerReplyStatus.enumValues)[number];

export type ReplyEvent =
	// Resend took an Amazon reply; its email ID.
	| { kind: "accepted"; externalId: string }
	// The marketplace has it. eBay gives its message ID here; an Amazon
	// reply already has Resend's.
	| { kind: "delivered"; externalId?: string }
	// The marketplace or Resend said no, so it didn't go.
	| { kind: "failed"; error: string }
	// Amazon's notice that it didn't pass a reply on, after taking it.
	| { kind: "refused"; error: string; noticeId: number }
	// No answer came in time to know: it may have gone.
	| { kind: "unconfirmed"; error: string };

export const FOLLOWS: Record<ReplyEvent["kind"], ReplyStatus[]> = {
	accepted: ["sending"],
	delivered: ["sending", "sent", "unconfirmed"],
	failed: ["sending", "sent"],
	refused: ["sent", "delivered"],
	unconfirmed: ["sending"],
};

const STATUS_OF: Record<ReplyEvent["kind"], ReplyStatus> = {
	accepted: "sent",
	delivered: "delivered",
	failed: "failed",
	refused: "failed",
	unconfirmed: "unconfirmed",
};

// Whether a reply answers the buyer: one that failed doesn't, and one that
// may not have gone isn't counted on.
export const answers = (status: ReplyStatus | null) =>
	status === "sending" || status === "sent" || status === "delivered";

// Moves a reply on; false when it wasn't in a state the event follows, so
// nothing changed.
export async function settleReply(db: Db, id: number, event: ReplyEvent) {
	const [row] = await db
		.update(buyerMessages)
		.set({
			status: STATUS_OF[event.kind],
			statusAt: new Date(),
			...("externalId" in event && event.externalId
				? { externalId: event.externalId }
				: {}),
			...("error" in event ? { error: event.error } : { error: null }),
			...(event.kind === "refused" ? { refusedBy: event.noticeId } : {}),
		})
		.where(
			and(
				eq(buyerMessages.id, id),
				eq(buyerMessages.fromBuyer, false),
				inArray(buyerMessages.status, FOLLOWS[event.kind]),
			),
		)
		.returning({ id: buyerMessages.id });
	return row !== undefined;
}

// A send whose outcome isn't known (no answer, a timeout, the marketplace
// erring on its side, an answer that didn't read), so the reply stays
// sending for the cron to settle. Only Refused means it didn't go.
export class Unsure extends Error {
	name = "Unsure";
}

// The marketplace (or Resend) plainly said no: nothing went.
export class Refused extends Error {
	name = "Refused";
}

// An HTTP answer as one of the two: 5xx, 429, and 409 (Resend still working
// on the same key) may yet go through.
export function unsureStatus(status: number) {
	return status >= 500 || status === 429 || status === 409;
}

// Replies still in flight: sending, sent and not yet delivered, or
// unconfirmed in the last week (still looked for, in case it turns up).
export async function unsettledReplies(db: Db, now = new Date()) {
	const week = new Date(now.getTime() - 7 * 86_400_000);
	return db
		.select()
		.from(buyerMessages)
		.where(
			or(
				inArray(buyerMessages.status, ["sending", "sent"]),
				and(
					eq(buyerMessages.status, "unconfirmed"),
					gt(buyerMessages.at, week),
				),
			),
		)
		.orderBy(buyerMessages.id);
}
