import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { buyerMessages, type buyerReplyStatus } from "#/db/schema";

// Where a reply we wrote stands, and the only way it moves on. Every write to
// a reply's status goes through settleReply, which updates only from the
// states its event may follow, so a late or repeated event (a cron finding
// what the send already recorded, two runs at once) changes nothing.
//
//   sending ──accepted──▶ sent ──delivered──▶ delivered
//      │                   │                     │
//      ├──delivered────────┼─────────────────────┘ (eBay: straight there)
//      └──failed / lost────┴──failed────▶ failed ◀─┘ (Amazon refusing it later)
//
// failed is the end: sending it again is a new reply.

export type ReplyStatus = (typeof buyerReplyStatus.enumValues)[number];

export type ReplyEvent =
	// Resend took an Amazon reply; its email ID.
	| { kind: "accepted"; externalId: string }
	// The marketplace has it. eBay gives its message ID here; an Amazon
	// reply already has Resend's.
	| { kind: "delivered"; externalId?: string }
	// The marketplace refused it, or bounced it after taking it.
	| { kind: "failed"; error: string }
	// Never confirmed: no answer, and it isn't there when looked for. Only
	// from sending, so a reply found meanwhile is never undone.
	| { kind: "lost"; error: string };

export const FOLLOWS: Record<ReplyEvent["kind"], ReplyStatus[]> = {
	accepted: ["sending"],
	delivered: ["sending", "sent"],
	failed: ["sending", "sent", "delivered"],
	lost: ["sending"],
};

const STATUS_OF: Record<ReplyEvent["kind"], ReplyStatus> = {
	accepted: "sent",
	delivered: "delivered",
	failed: "failed",
	lost: "failed",
};

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
			...("error" in event ? { error: event.error } : {}),
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
// erring on its side), so the reply stays sending for the cron to settle.
// Any other error is the marketplace saying no: failed.
export class Unsure extends Error {
	name = "Unsure";
}

// An HTTP answer as one of the two: 5xx, 429, and 409 (Resend still working
// on the same key) may yet go through.
export function unsureStatus(status: number) {
	return status >= 500 || status === 429 || status === 409;
}

// Replies still in flight: sending, or sent and not yet delivered.
export async function unsettledReplies(db: Db) {
	return db
		.select()
		.from(buyerMessages)
		.where(sql`${buyerMessages.status} in ('sending', 'sent')`);
}
