import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { marketEmails } from "#/db/schema";
import type { Market } from "#/markets/market";
import { type Header, senderAuthenticated } from "../sender-auth";

// Whose sender is asked about: mail from no marketplace (a buyer
// answering) and from Amazon (its buyer relay, its copies and notices),
// which can become buyer messages. The rest only sorts.
export function checksSender(market: Market | null) {
	return market === null || market === "amazon";
}

// Buyer mail is filed this far back at most (src/buyers/shopify-mail.ts),
// so older mail isn't asked about.
const LOOK_BACK_MS = 60 * 86_400_000;

// Asks again for emails kept without their sender ever being asked (as
// every one was while the mailbox read skipped headers), a batch per sweep,
// so the threading after it files the ones Microsoft vouched for. Null
// headers is an email gone from the mailbox: asked, and not vouched for. A
// failure leaves it for the next sweep. Newest first, so an email that keeps
// failing can't hold back the ones after it; it ages out of the look-back.
export async function recheckSenders(
	db: Db,
	readHeaders: (messageId: string) => Promise<Header[] | null>,
	limit = 50,
) {
	const rows = await db
		.select({
			id: marketEmails.id,
			messageId: marketEmails.messageId,
			fromAddress: marketEmails.fromAddress,
		})
		.from(marketEmails)
		.where(
			and(
				isNull(marketEmails.senderCheckedAt),
				or(isNull(marketEmails.market), eq(marketEmails.market, "amazon")),
				gte(marketEmails.receivedAt, new Date(Date.now() - LOOK_BACK_MS)),
			),
		)
		.orderBy(desc(marketEmails.receivedAt))
		.limit(limit);
	let vouched = 0;
	for (const r of rows) {
		try {
			const authenticated = senderAuthenticated(
				(await readHeaders(r.messageId)) ?? [],
				r.fromAddress,
			);
			await db
				.update(marketEmails)
				.set({
					senderAuthenticated: authenticated,
					senderCheckedAt: new Date(),
				})
				.where(eq(marketEmails.id, r.id));
			if (authenticated) vouched++;
		} catch {
			// Left for the next sweep.
		}
	}
	return vouched;
}
