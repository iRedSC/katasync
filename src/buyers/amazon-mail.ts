import { and, eq, gte, ilike, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	buyerMessages,
	buyerThreads,
	marketEmailAttachments,
	marketEmails,
} from "#/db/schema";
import { Refused, settleReply, Unsure, unsureStatus } from "./states";
import { ensureThread, recordFromBuyer } from "./threads";

// Amazon buyer messages, which reach us only as email: Amazon relays each
// from an address standing for the buyer (…@marketplace.amazon.com) to the
// marketplaces mailbox, and relays our answer back when it's sent to that
// address from a sender approved in Seller Central. So the mailbox read
// (src/inbox/market-mail.ts) is what brings them in, and Resend sends ours.

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
				isNull(buyerMessages.id),
			),
		)
		.orderBy(marketEmails.receivedAt);
	// Files the buyer attached, as kept with each email (not its inline
	// pictures, which are Amazon's logos).
	const files =
		pending.length === 0
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
							inArray(
								marketEmailAttachments.emailId,
								pending.map((e) => e.id),
							),
							isNull(marketEmailAttachments.contentId),
						),
					)
					.orderBy(marketEmailAttachments.id);
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
				media: files
					.filter((f) => f.emailId === e.id)
					.map((f) => ({
						kind: f.contentType.startsWith("image/") ? "IMAGE" : "FILE",
						name: f.filename,
						url: `/api/market-email-attachments/${f.id}`,
					})),
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
			subject: marketEmails.subject,
			body: marketEmails.body,
			receivedAt: marketEmails.receivedAt,
		})
		.from(marketEmails)
		.leftJoin(buyerMessages, eq(buyerMessages.refusedBy, marketEmails.id))
		.where(
			and(
				eq(marketEmails.market, "amazon"),
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

// Hands a reply to Resend. The request key makes a retry the same send, so
// one unsure attempt can be tried again without the buyer getting two.
// Resend's email ID back; throws Unsure when it may yet have gone.
export async function sendAmazonReply(r: {
	to: string;
	subject: string;
	inReplyTo: string | null;
	text: string;
	requestKey: string;
}) {
	const key = process.env.RESEND_API_KEY;
	const from = replyFrom();
	if (!key || !from)
		throw new Refused(
			"Replies aren't set up: add RESEND_API_KEY and MARKETPLACE_INBOX",
		);
	let res: Response;
	let body: { id?: string; message?: string; name?: string } | null;
	try {
		res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"Idempotency-Key": r.requestKey,
			},
			body: JSON.stringify({
				from,
				to: [r.to],
				subject: /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`,
				text: r.text,
				...(r.inReplyTo
					? { headers: { "In-Reply-To": r.inReplyTo, References: r.inReplyTo } }
					: {}),
			}),
		});
		body = await res.json().catch(() => null);
	} catch (error) {
		throw new Unsure(error instanceof Error ? error.message : String(error));
	}
	if (res.ok && body?.id) return body.id;
	const why = `Resend answered ${res.status}: ${body?.message ?? res.statusText}`;
	// Taken without an ID to show, or not answered plainly: it may have gone.
	throw res.ok || unsureStatus(res.status) ? new Unsure(why) : new Refused(why);
}

// Resend's events (resend.com/docs/dashboard/emails/introduction): which
// mean Amazon's server has it, which mean it never got there, and which are
// still on the way. One not listed is reported rather than guessed at.
const ARRIVED = ["delivered", "opened", "clicked", "complained"];
const NEVER = ["bounced", "failed", "suppressed", "canceled"];
const GOING = ["queued", "scheduled", "sent", "delivery_delayed"];

// What Resend last heard of a reply.
export async function amazonReplyStatus(resendId: string) {
	const res = await fetch(
		`https://api.resend.com/emails/${encodeURIComponent(resendId)}`,
		{ headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } },
	);
	if (!res.ok)
		throw new Error(`Resend answered ${res.status}: ${await res.text()}`);
	const { last_event: last = "" } = (await res.json()) as {
		last_event?: string;
	};
	if (ARRIVED.includes(last)) return { state: "delivered" as const };
	if (NEVER.includes(last))
		return { state: "failed" as const, error: `Resend says it ${last}` };
	if (GOING.includes(last)) return { state: "going" as const };
	throw new Error(`Resend says ${last || "nothing"} of reply ${resendId}`);
}
