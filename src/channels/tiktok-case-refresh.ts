import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { importReturns } from "#/orders/return-requests";
import type { OrderUpdate } from "./order-update";
import { tiktokReturnsWithRecords } from "./tiktok-return-history";
import type { ReadRecords } from "./tiktok-return-records";
import { type CaseLookup, fetchTiktokCases } from "./tiktok-returns";

// A TikTok case a webhook named, read again from the aftersales API by id
// and saved the way a returns pass saves it, records too. The webhook inbox
// tries again while it can't be read, isn't on TikTok's search yet, or is
// for an order katasync doesn't have yet. It leaves the returns feed's
// health alone: one case says nothing of the feed, so only the pass settles
// it, and records that don't read are the pass's to retry (recordsUnread)
// and report. Run under the returns pass's lock (ingestWebhookCase). Server
// only.

type Options = {
	fetch?: typeof fetchTiktokCases;
	readRecords?: ReadRecords;
};

export async function refreshTiktokCase(
	db: Db,
	lookup: CaseLookup,
	options: Options = {},
): Promise<OrderUpdate> {
	const fetch = options.fetch ?? fetchTiktokCases;
	const [store] = await db
		.select()
		.from(stores)
		.where(eq(stores.channel, "tiktok"))
		.limit(1);
	if (!store)
		return {
			kind: "retry",
			error: "No tiktok store yet: its orders haven't synced",
		};
	let cases = 0;
	const read = await importReturns(db, store, async () => {
		const got = await fetch(lookup);
		cases = got.found;
		return tiktokReturnsWithRecords(db, got.returns, options.readRecords);
	});
	const named = `TikTok ${lookup.kind === "aftersales" ? "case" : "returns on order"} ${lookup.id}`;
	switch (read.kind) {
		case "failed":
			return { kind: "retry", error: read.error };
		case "pending":
			return { kind: "retry", error: `${named}: nothing to read yet` };
		case "read": {
			const waiting = [
				...(cases === 0 ? [`${named} isn't on TikTok's search yet`] : []),
				...read.held.map((h) => h.detail),
			];
			return waiting.length > 0
				? { kind: "retry", error: waiting.join("; ") }
				: { kind: "applied" };
		}
	}
}
