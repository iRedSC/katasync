import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { type BuyerMedia, buyerMessages } from "#/db/schema";
import { settleReply } from "./states";
import { isLogged, recordFromBuyer, recordOurs } from "./threads";

// A conversation as a marketplace with a messaging API (eBay, TikTok) lists
// it, kept in one thread: the buyer's messages, ours sent on the
// marketplace's own site, and ours sent from katasync whose outcome wasn't
// known, now settled by finding them.

export type ListedMessage = {
	externalId: string;
	body: string;
	at: Date;
	ours: boolean;
	media: BuyerMedia[];
};

const CLOCK_SLACK_MS = 2 * 60_000;
const LOGGED_SLACK_MS = 24 * 3_600_000;

const same = (a: string, b: string) =>
	a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

// apart: our pictures go as messages of their own, before the words
// (TikTok). Each one found is written on the reply it belongs to, and the
// reply is delivered only once all of it is found: its words, which go last,
// or with none, every picture.
export async function keepConversation(
	db: Db,
	threadId: number,
	listed: ListedMessage[],
	{ apart = false } = {},
) {
	const kept = await db
		.select({
			id: buyerMessages.id,
			body: buyerMessages.body,
			at: buyerMessages.at,
			status: buyerMessages.status,
			externalId: buyerMessages.externalId,
			media: buyerMessages.media,
		})
		.from(buyerMessages)
		.where(eq(buyerMessages.threadId, threadId))
		.orderBy(buyerMessages.at);
	// The marketplace's IDs already on a message here, or on a picture of
	// one that went as its own message: never given to another.
	const claimed = new Set(
		kept.flatMap((k) => [k.externalId, ...k.media.map((m) => m.externalId)]),
	);
	// Ours whose send didn't say how it went, oldest first.
	// And ours staff added without sending, which the marketplace now reads
	// back.
	const waiting = kept.filter(
		(k) =>
			isLogged(k.externalId) ||
			(k.externalId === null &&
				(k.status === "sending" || k.status === "unconfirmed")),
	);
	// Sent no earlier than we wrote it (allowing for clocks). One added
	// without sending was sent on the marketplace before it was added.
	const after = (m: ListedMessage, w: (typeof waiting)[number]) =>
		m.at.getTime() >=
		w.at.getTime() -
			(isLogged(w.externalId) ? LOGGED_SLACK_MS : CLOCK_SLACK_MS);
	const sorted = [...listed].sort((a, b) => a.at.getTime() - b.at.getTime());
	for (const m of sorted) {
		if (!m.ours) {
			await recordFromBuyer(db, threadId, m);
			continue;
		}
		if (claimed.has(m.externalId)) continue;
		claimed.add(m.externalId);
		// A picture alone: the first of a reply's not yet found.
		if (apart && !m.body.trim() && m.media.length > 0) {
			const owner = waiting.find(
				(w) =>
					!isLogged(w.externalId) &&
					after(m, w) &&
					w.media.some((f) => f.fileId && !f.externalId),
			);
			const at = owner?.media.findIndex((f) => f.fileId && !f.externalId);
			const part = at === undefined ? undefined : owner?.media[at];
			if (owner && at !== undefined && part) {
				owner.media[at] = { ...part, externalId: m.externalId };
				await db
					.update(buyerMessages)
					.set({ media: owner.media })
					.where(eq(buyerMessages.id, owner.id));
				continue;
			}
		}
		// The same words.
		const match = waiting.findIndex(
			(w) => !!w.body.trim() && same(w.body, m.body) && after(m, w),
		);
		const pending = match >= 0 ? waiting.splice(match, 1)[0] : undefined;
		if (pending && isLogged(pending.externalId)) {
			await db
				.update(buyerMessages)
				.set({ externalId: m.externalId })
				.where(eq(buyerMessages.id, pending.id));
			continue;
		}
		if (
			pending &&
			(await settleReply(db, pending.id, {
				kind: "delivered",
				externalId: m.externalId,
			}).catch(() => false))
		)
			continue;
		await recordOurs(db, threadId, m);
	}
	if (!apart) return;
	// Pictures without words: delivered once every one is found.
	const seen = new Set(listed.map((m) => m.externalId));
	for (const w of waiting) {
		const files = w.media.filter((f) => f.fileId);
		const last = files.at(-1)?.externalId;
		if (
			isLogged(w.externalId) ||
			w.body.trim() ||
			!last ||
			!files.every((f) => f.externalId && seen.has(f.externalId))
		)
			continue;
		await settleReply(db, w.id, { kind: "delivered", externalId: last }).catch(
			() => false,
		);
	}
}
