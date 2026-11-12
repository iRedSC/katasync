import type { buyerReplyStatus } from "#/db/schema";

// Where a reply of ours stands. Replies are sent on the marketplaces now;
// read back from them, they're delivered. Older ones katasync sent itself
// keep the status they settled at.

export type ReplyStatus = (typeof buyerReplyStatus.enumValues)[number];

// Whether a reply answers the buyer: one that failed doesn't, and one that
// may not have gone isn't counted on.
export const ANSWERING: ReplyStatus[] = ["sending", "sent", "delivered"];
export const answers = (status: ReplyStatus | null) =>
	status !== null && ANSWERING.includes(status);
