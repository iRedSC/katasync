import type { Db } from "#/db/client";
import type { BuyerMedia } from "#/db/schema";
import { recordFromBuyer, recordOurs } from "./threads";

// A conversation as a marketplace with a messaging API (eBay, TikTok) lists
// it, kept in one thread: the buyer's messages and ours, each once by the
// marketplace's ID, so the thread knows whether it waits on us.

export type ListedMessage = {
	externalId: string;
	body: string;
	at: Date;
	ours: boolean;
	media: BuyerMedia[];
};

export async function keepConversation(
	db: Db,
	threadId: number,
	listed: ListedMessage[],
) {
	const sorted = [...listed].sort((a, b) => a.at.getTime() - b.at.getTime());
	for (const m of sorted) {
		if (m.ours) await recordOurs(db, threadId, m);
		else await recordFromBuyer(db, threadId, m);
	}
}
