import { and, eq, gte, ilike, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type BuyerMedia,
	buyerMessages,
	buyerThreads,
	marketEmailAttachments,
	marketEmails,
} from "#/db/schema";
import { isAmazonAddress } from "#/inbox/sender-domains";
import { ensureThread, recordFromBuyer, recordOurs } from "./threads";

// Amazon buyer messages, which reach us only as email: Amazon relays each
// from an address standing for the buyer (…@marketplace.amazon.com) to the
// marketplaces mailbox, and copies us on what we answer in Seller Central.
// So the mailbox read (src/inbox/market-mail.ts) is what brings both in.
// Anyone can write an Amazon From, so only mail Microsoft vouched came from
// Amazon (market_emails.sender_authenticated) is filed; the rest stays in
// the mailbox, marked unverified. Microsoft vouches only that the sender
// owns the From's domain, so Amazon's copies and notices must come from
// one of Amazon's own domains too, whatever market was stored for them.

const RELAY = /@marketplace\.amazon\.com$/i;
const ORDER = /\b\d{3}-\d{7}-\d{7}\b/;

export function isRelayed(fromAddress: string) {
	return RELAY.test(fromAddress.trim());
}

// What a relayed email says: the buyer, the order, and their words without
// Amazon's wrapping. The whole body when Amazon's layout isn't recognised,
// so nothing the buyer wrote is ever dropped.
export function parseRelayed(email: { subject: string; body: string }) {
	const name =
		/customer\s+(.+?)\s*\((?:Order|Bestellung)/i.exec(email.subject)?.[1] ??
		null;
	const orderRef =
		ORDER.exec(email.subject)?.[0] ?? ORDER.exec(email.body)?.[0] ?? null;
	const start = /^\s*Message:\s*$/im.exec(email.body);
	let text = email.body;
	if (start) {
		const rest = email.body.slice(start.index + start[0].length);
		const end =
			/^\s*(View Message|Resolve Case|Was this email helpful|-{5,})/im.exec(
				rest,
			);
		text = end ? rest.slice(0, end.index) : rest;
	}
	return {
		buyerName: name,
		orderRef,
		text: text.replace(/\r\n/g, "\n").trim() || email.body.trim(),
	};
}

// Files every relayed email not yet in a thread. Safe to run again: each
// email is one message, by its Message-ID.
export async function threadAmazonMail(db: Db) {
	const pending = await db
		.select({
			id: marketEmails.id,
			messageId: marketEmails.messageId,
			fromAddress: marketEmails.fromAddress,
			subject: marketEmails.subject,
			body: marketEmails.body,
			receivedAt: marketEmails.receivedAt,
		})
		.from(marketEmails)
		.leftJoin(buyerMessages, eq(buyerMessages.marketEmailId, marketEmails.id))
		.where(
			and(
				ilike(marketEmails.fromAddress, "%@marketplace.amazon.com"),
				eq(marketEmails.senderAuthenticated, true),
				isNull(buyerMessages.id),
			),
		)
		.orderBy(marketEmails.receivedAt);
	const media = await mediaOf(
		db,
		pending.map((e) => e.id),
	);
	let filed = 0;
	for (const e of pending) {
		if (!isRelayed(e.fromAddress)) continue;
		const p = parseRelayed(e);
		const added = await db.transaction(async (tx) => {
			const thread = await ensureThread(tx, {
				market: "amazon",
				externalId: e.fromAddress.trim().toLowerCase(),
				subject: e.subject.replace(/^(re|fw|fwd):\s*/i, ""),
				buyerName: p.buyerName,
				orderRef: p.orderRef,
			});
			return recordFromBuyer(tx, thread.id, {
				externalId: e.messageId,
				body: p.text,
				at: e.receivedAt,
				marketEmailId: e.id,
				media: media(e.id),
			});
		});
		if (added) filed++;
	}
	return filed + (await threadAmazonCopies(db));
}

// Files the emails came with, as kept with each (not their inline
// pictures, which are Amazon's logos), by email.
export async function mediaOf(db: Db, emailIds: number[]) {
	const files =
		emailIds.length === 0
			? []
			: await db
					.select({
						id: marketEmailAttachments.id,
						emailId: marketEmailAttachments.emailId,
						filename: marketEmailAttachments.filename,
						contentType: marketEmailAttachments.contentType,
					})
					.from(marketEmailAttachments)
					.where(
						and(
							inArray(marketEmailAttachments.emailId, emailIds),
							isNull(marketEmailAttachments.contentId),
						),
					)
					.orderBy(marketEmailAttachments.id);
	return (emailId: number): BuyerMedia[] =>
		files
			.filter((f) => f.emailId === emailId)
			.map((f) => ({
				kind: f.contentType.startsWith("image/") ? "IMAGE" : "FILE",
				name: f.filename,
				url: `/api/market-email-attachments/${f.id}`,
			}));
}

// Amazon's copy of a message sent in Seller Central ("Your e-mail to
// Rick"): the order it was about and our words. Null when it isn't one.
export function parseCopy(email: { subject: string; body: string }) {
	if (!/^your e-?mail to\b/i.test(email.subject.trim())) return null;
	const orderRef = /Order ID:\s*(\d{3}-\d{7}-\d{7})/i.exec(email.body)?.[1];
	const between =
		/-{3,}\s*Begin message\s*-{3,}([\s\S]*?)-{3,}\s*End message\s*-{3,}/i.exec(
			email.body,
		)?.[1];
	if (!orderRef || between === undefined) return null;
	return { orderRef, text: between.replace(/\r\n/g, "\n").trim() };
}

const COPIES_SINCE_MS = 30 * 86_400_000;

// Puts what staff sent in Seller Central on its thread, from Amazon's copy,
// kept once, by the copy. A copy for an order with no thread here (or two) is
// left; there's no buyer address to answer on.
export async function threadAmazonCopies(db: Db) {
	const pending = await db
		.select({
			id: marketEmails.id,
			messageId: marketEmails.messageId,
			fromAddress: marketEmails.fromAddress,
			subject: marketEmails.subject,
			body: marketEmails.body,
			receivedAt: marketEmails.receivedAt,
		})
		.from(marketEmails)
		.leftJoin(buyerMessages, eq(buyerMessages.marketEmailId, marketEmails.id))
		.where(
			and(
				eq(marketEmails.market, "amazon"),
				eq(marketEmails.senderAuthenticated, true),
				ilike(marketEmails.subject, "your e%mail to%"),
				gte(marketEmails.receivedAt, new Date(Date.now() - COPIES_SINCE_MS)),
				isNull(buyerMessages.id),
			),
		)
		.orderBy(marketEmails.receivedAt);
	const media = await mediaOf(
		db,
		pending.map((e) => e.id),
	);
	let filed = 0;
	for (const e of pending) {
		const copy = isAmazonAddress(e.fromAddress) ? parseCopy(e) : null;
		if (!copy) continue;
		const threads = await db
			.select({ id: buyerThreads.id })
			.from(buyerThreads)
			.where(
				and(
					eq(buyerThreads.market, "amazon"),
					eq(buyerThreads.orderRef, copy.orderRef),
				),
			);
		const [thread, ...more] = threads;
		if (!thread || more.length > 0) continue;
		const added = await recordOurs(db, thread.id, {
			externalId: e.messageId,
			body: copy.text,
			at: e.receivedAt,
			media: media(e.id),
			marketEmailId: e.id,
		});
		if (added) filed++;
	}
	return filed;
}
