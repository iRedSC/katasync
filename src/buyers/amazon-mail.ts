import { and, eq, gte, ilike, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type BuyerMedia,
	buyerMessages,
	buyerThreads,
	marketEmailAttachments,
	marketEmails,
} from "#/db/schema";
import { isAmazonAddress } from "#/inbox/sender-domains";
import { sendWithResend } from "./resend";
import { Refused, settleReply } from "./states";
import { ensureThread, isLogged, recordFromBuyer, recordOurs } from "./threads";

// Amazon buyer messages, which reach us only as email: Amazon relays each
// from an address standing for the buyer (…@marketplace.amazon.com) to the
// marketplaces mailbox, and relays our answer back when it's sent to that
// address from a sender approved in Seller Central. So the mailbox read
// (src/inbox/market-mail.ts) is what brings them in, and Resend sends ours.
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
// Ours with the same words this near the copy are the one it's of.
const LOGGED_SLACK_MS = 24 * 3_600_000;
const same = (a: string, b: string) =>
	a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

// Puts what staff sent in Seller Central on its thread, from Amazon's copy:
// it takes the place of the same words added without sending, and is kept
// once, by the copy. A copy for an order with no thread here (or two) is
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
		const added = await db.transaction(async (tx) => {
			const ours = await tx
				.select({
					id: buyerMessages.id,
					body: buyerMessages.body,
					at: buyerMessages.at,
					externalId: buyerMessages.externalId,
					marketEmailId: buyerMessages.marketEmailId,
				})
				.from(buyerMessages)
				.where(
					and(
						eq(buyerMessages.threadId, thread.id),
						eq(buyerMessages.fromBuyer, false),
					),
				)
				.orderBy(buyerMessages.at);
			const sameWords = ours.filter(
				(m) =>
					m.marketEmailId === null &&
					same(m.body, copy.text) &&
					Math.abs(e.receivedAt.getTime() - m.at.getTime()) <= LOGGED_SLACK_MS,
			);
			const match = sameWords.find((m) => isLogged(m.externalId));
			if (match) {
				await tx
					.update(buyerMessages)
					.set({
						externalId: e.messageId,
						marketEmailId: e.id,
						at: e.receivedAt,
						media: media(e.id),
					})
					.where(eq(buyerMessages.id, match.id));
				return true;
			}
			// Should Amazon ever copy one sent from here, it's that one.
			const sent = sameWords[0];
			if (sent) {
				await tx
					.update(buyerMessages)
					.set({ marketEmailId: e.id })
					.where(eq(buyerMessages.id, sent.id));
				return false;
			}
			return recordOurs(tx, thread.id, {
				externalId: e.messageId,
				body: copy.text,
				at: e.receivedAt,
				media: media(e.id),
				marketEmailId: e.id,
			});
		});
		if (added) filed++;
	}
	return filed;
}

// Amazon's word that it didn't pass one of ours on. Its wording varies, so
// any Amazon email saying a message wasn't delivered counts, matched to the
// thread by the buyer's address or the order it names.
const REFUSAL =
	/(not|n't|unable to)\b.{0,40}\bdeliver|undeliverable|delivery (failure|failed)|message (was )?blocked/i;

const LOOK_BACK_MS = 7 * 86_400_000;
// A refusal comes within hours of the reply it's about.
const REFUSED_WITHIN_MS = 3 * 86_400_000;

// Fails the reply each refusal is about. Amazon's notice doesn't say which
// reply, so it counts only when its thread had exactly one reply out in the
// days before it; with more, failing one would be a guess, and it's left.
// Each notice fails one reply at most, recorded with it.
export async function applyAmazonRefusals(db: Db) {
	const since = new Date(Date.now() - LOOK_BACK_MS);
	const notices = await db
		.select({
			id: marketEmails.id,
			fromAddress: marketEmails.fromAddress,
			subject: marketEmails.subject,
			body: marketEmails.body,
			receivedAt: marketEmails.receivedAt,
		})
		.from(marketEmails)
		.leftJoin(buyerMessages, eq(buyerMessages.refusedBy, marketEmails.id))
		.where(
			and(
				eq(marketEmails.market, "amazon"),
				eq(marketEmails.senderAuthenticated, true),
				gte(marketEmails.receivedAt, since),
				isNull(buyerMessages.id),
			),
		);
	const threads = await db
		.select({
			id: buyerThreads.id,
			externalId: buyerThreads.externalId,
			orderRef: buyerThreads.orderRef,
		})
		.from(buyerThreads)
		.where(eq(buyerThreads.market, "amazon"));
	let failed = 0;
	for (const n of notices) {
		if (!isAmazonAddress(n.fromAddress)) continue;
		// About a message, not a package Amazon couldn't deliver.
		if (!REFUSAL.test(n.subject) || !/message|e-?mail/i.test(n.subject))
			continue;
		const text = `${n.subject}\n${n.body}`.toLowerCase();
		const about = threads.filter(
			(t) =>
				text.includes(t.externalId) ||
				(t.orderRef !== null && text.includes(t.orderRef)),
		);
		const [thread, ...more] = about;
		if (!thread || more.length > 0) continue;
		const candidates = await db
			.select({ id: buyerMessages.id })
			.from(buyerMessages)
			.where(
				and(
					eq(buyerMessages.threadId, thread.id),
					eq(buyerMessages.fromBuyer, false),
					lte(buyerMessages.at, n.receivedAt),
					gte(
						buyerMessages.at,
						new Date(n.receivedAt.getTime() - REFUSED_WITHIN_MS),
					),
					or(
						eq(buyerMessages.status, "sent"),
						eq(buyerMessages.status, "delivered"),
					),
				),
			);
		const [reply, ...others] = candidates;
		if (!reply || others.length > 0) continue;
		if (
			await settleReply(db, reply.id, {
				kind: "refused",
				error: `Amazon didn't pass it on: ${n.subject}`,
				noticeId: n.id,
			})
		)
			failed++;
	}
	return failed;
}

// Who our replies come from: an address Seller Central approves.
export function replyFrom() {
	return (
		process.env.BUYER_REPLY_FROM?.trim() ||
		process.env.MARKETPLACE_INBOX?.trim() ||
		null
	);
}

// Hands a reply to Resend, from an address Seller Central approves.
export async function sendAmazonReply(r: {
	to: string;
	subject: string;
	inReplyTo: string | null;
	text: string;
	requestKey: string;
	attachments?: { filename: string; content: string }[];
}) {
	const from = replyFrom();
	if (!process.env.RESEND_API_KEY || !from)
		throw new Refused(
			"Replies aren't set up: add RESEND_API_KEY and MARKETPLACE_INBOX",
		);
	return sendWithResend({
		...r,
		from,
		subject: /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`,
	});
}
