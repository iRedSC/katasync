import { and, desc, eq, gte, ilike, isNull, lte, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { buyerMessages, buyerThreads, marketEmails } from "#/db/schema";
import { settleReply, Unsure, unsureStatus } from "./states";
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

// Fails the reply each refusal is about: the latest of ours on its thread
// sent before it. Safe to run again; a reply fails once.
export async function applyAmazonRefusals(db: Db) {
	const since = new Date(Date.now() - LOOK_BACK_MS);
	const notices = await db
		.select({
			subject: marketEmails.subject,
			body: marketEmails.body,
			receivedAt: marketEmails.receivedAt,
		})
		.from(marketEmails)
		.where(
			and(
				eq(marketEmails.market, "amazon"),
				gte(marketEmails.receivedAt, since),
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
		if (about.length !== 1) continue;
		const [thread] = about;
		const [reply] = await db
			.select({ id: buyerMessages.id })
			.from(buyerMessages)
			.where(
				and(
					eq(buyerMessages.threadId, thread?.id ?? 0),
					eq(buyerMessages.fromBuyer, false),
					lte(buyerMessages.at, n.receivedAt),
					or(
						eq(buyerMessages.status, "sent"),
						eq(buyerMessages.status, "delivered"),
					),
				),
			)
			.orderBy(desc(buyerMessages.at))
			.limit(1);
		if (!reply) continue;
		if (
			await settleReply(db, reply.id, {
				kind: "failed",
				error: `Amazon didn't pass it on: ${n.subject}`,
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
		throw new Error(
			"Replies aren't set up: add RESEND_API_KEY and MARKETPLACE_INBOX",
		);
	let res: Response;
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
	} catch (error) {
		throw new Unsure(error instanceof Error ? error.message : String(error));
	}
	const body = (await res.json().catch(() => null)) as {
		id?: string;
		message?: string;
	} | null;
	if (res.ok && body?.id) return body.id;
	const why = `Resend answered ${res.status}: ${body?.message ?? res.statusText}`;
	throw unsureStatus(res.status) || res.ok ? new Unsure(why) : new Error(why);
}

// What Resend last heard of a reply: delivered (Amazon's server took it),
// failed (bounced), or still going.
export async function amazonReplyStatus(resendId: string) {
	const res = await fetch(
		`https://api.resend.com/emails/${encodeURIComponent(resendId)}`,
		{ headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } },
	);
	if (!res.ok)
		throw new Error(`Resend answered ${res.status}: ${await res.text()}`);
	const { last_event: last } = (await res.json()) as { last_event?: string };
	if (last === "delivered") return { state: "delivered" as const };
	if (last === "bounced" || last === "failed" || last === "complained")
		return { state: "failed" as const, error: `Amazon's server ${last} it` };
	return { state: "going" as const };
}
