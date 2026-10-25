import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	buyerMessages,
	buyerThreads,
	marketEmails,
	orders,
	stores,
} from "#/db/schema";
import { mediaOf } from "./amazon-mail";
import { sendWithResend } from "./resend";
import { Refused } from "./states";
import { ensureThread, recordFromBuyer } from "./threads";

// Emailing the buyers of Shopify's own orders, who have no marketplace chat:
// staff start a thread from the order, Resend sends it from the store's
// address (SHOPIFY_EMAIL_FROM), and its Reply-To is the thread's own address
// in the marketplaces mailbox (marketplaces+so12@), so the answer is read in
// with the rest of that mailbox and filed back on the thread. A relayed
// TikTok order's buyer is TikTok's, so it never gets one. Shopify Inbox,
// the storefront's web chat, is apart from this: it has no public API.

const ADDRESS = /^[^@\s+]+@[^@\s]+$/;

function inbox() {
	const box = process.env.MARKETPLACE_INBOX?.trim().toLowerCase();
	return box && ADDRESS.test(box) ? box : null;
}

// Why Shopify buyers can't be emailed yet, or null when they can.
export function emailUnready() {
	const missing = [
		!process.env.RESEND_API_KEY && "RESEND_API_KEY",
		!process.env.SHOPIFY_EMAIL_FROM?.trim() && "SHOPIFY_EMAIL_FROM",
		!inbox() && "MARKETPLACE_INBOX",
	].filter(Boolean);
	return missing.length > 0 ? `Set ${missing.join(", ")}` : null;
}

// The address a thread's emails ask to be answered at.
export function threadAddress(threadId: number) {
	const box = inbox();
	if (!box) return null;
	const [local, domain] = box.split("@");
	return `${local}+so${threadId}@${domain}`;
}

// The thread an address names, if it's one of ours.
export function threadOfAddress(address: string) {
	const box = inbox();
	if (!box) return null;
	const [local, domain] = box.split("@");
	const m = /^([^@+]+)\+so(\d{1,9})@(.+)$/i.exec(address.trim());
	if (!m || m[1].toLowerCase() !== local || m[3].toLowerCase() !== domain)
		return null;
	return Number(m[2]);
}

// The thread for an order, made the first time someone emails its buyer,
// and opened again if someone was done with it.
export async function startShopifyThread(db: Db, orderId: number) {
	const [o] = await db
		.select({
			externalId: orders.externalId,
			name: orders.name,
			customerName: orders.customerName,
			buyerEmail: orders.buyerEmail,
			marketplaceOrderId: orders.marketplaceOrderId,
			channel: stores.channel,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(orders.id, orderId));
	if (!o) throw new Error(`There's no order ${orderId}`);
	if (o.channel !== "shopify" || o.marketplaceOrderId)
		throw new Error(`${o.name}'s buyer is answered on its marketplace`);
	if (!o.buyerEmail) throw new Error(`Shopify has no email for ${o.name}`);
	const unready = emailUnready();
	if (unready) throw new Error(unready);
	const thread = await ensureThread(db, {
		market: "shopify",
		externalId: o.externalId,
		subject: `Your order ${o.name}`,
		buyerName: o.customerName,
		orderRef: o.externalId,
	});
	if (thread.doneAt)
		await db
			.update(buyerThreads)
			.set({ doneAt: null })
			.where(eq(buyerThreads.id, thread.id));
	return { threadId: thread.id };
}

// Where a thread's emails go: its order's buyer, as Shopify last said.
export async function shopifyRecipient(db: Db, orderRef: string | null) {
	const [o] = orderRef
		? await db
				.select({ email: orders.buyerEmail })
				.from(orders)
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.where(
					and(
						eq(stores.channel, "shopify"),
						eq(orders.externalId, orderRef),
						isNull(orders.marketplaceOrderId),
					),
				)
				.limit(1)
		: [];
	if (!o?.email) throw new Refused("Shopify has no email for this buyer");
	return o.email;
}

// Hands one of ours to Resend. A first email has the thread's subject; one
// answering the buyer is "Re:" it, under their latest email.
export async function sendShopifyEmail(r: {
	threadId: number;
	to: string;
	subject: string;
	inReplyTo: string | null;
	text: string;
	requestKey: string;
	attachments?: { filename: string; content: string }[];
}) {
	const from = process.env.SHOPIFY_EMAIL_FROM?.trim();
	const replyTo = threadAddress(r.threadId);
	if (!from || !replyTo) throw new Refused(emailUnready() ?? "Not set up");
	return sendWithResend({
		...r,
		from,
		replyTo,
		subject:
			r.inReplyTo && !/^re:/i.test(r.subject) ? `Re: ${r.subject}` : r.subject,
	});
}

export type ShopifyThreadRef = {
	id: number;
	email: string;
	orderName: string;
	open: boolean;
	createdAt: Date;
};

export type ReplyMatch =
	| { threadId: number; by: "address" | "order" | "sender" }
	| { threadId: null; why: string };

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Which thread a buyer's email answers: the thread address it was sent to,
// else the one order of theirs it names, else their one open thread.
// Anything less sure is left unmatched, never guessed between two.
export function matchShopifyReply(
	email: {
		fromAddress: string;
		recipients: string[];
		subject: string;
		body: string;
		receivedAt: Date;
	},
	threads: ShopifyThreadRef[],
): ReplyMatch {
	const sender = email.fromAddress.trim().toLowerCase();
	// Mail from before a thread was started isn't an answer to it.
	const theirs = threads.filter(
		(t) => t.email === sender && t.createdAt <= email.receivedAt,
	);
	if (theirs.length === 0) return { threadId: null, why: "not a buyer's" };
	const named = [
		...new Set(
			email.recipients
				.map(threadOfAddress)
				.filter((id): id is number => id !== null),
		),
	];
	if (named.length > 0) {
		const [one, ...more] = theirs.filter((t) => named.includes(t.id));
		return one && more.length === 0
			? { threadId: one.id, by: "address" }
			: { threadId: null, why: "its thread address isn't this buyer's" };
	}
	const text = `${email.subject}\n${email.body}`;
	const naming = theirs.filter((t) =>
		new RegExp(`(^|[^\\w#])${literal(t.orderName)}(?!\\d)`).test(text),
	);
	if (naming.length === 1) return { threadId: naming[0].id, by: "order" };
	if (naming.length > 1)
		return { threadId: null, why: "it names more than one of their orders" };
	const open = theirs.filter((t) => t.open);
	if (open.length === 1) return { threadId: open[0].id, by: "sender" };
	return {
		threadId: null,
		why: open.length > 1 ? "they have more than one open thread" : "no thread",
	};
}

// The buyer's own words: what they wrote above the email they answered.
// The whole body when nothing marks where that starts.
export function replyText(body: string) {
	const text = body.replace(/\r\n/g, "\n");
	const quote =
		/^(On .{4,200}wrote:\s*$|-{2,}\s*Original Message\s*-{2,}|_{10,}\s*$|From:\s.+$|Sent from my )/im.exec(
			text,
		);
	const above = quote ? text.slice(0, quote.index).trim() : "";
	return above || text.trim();
}

// Replies to a thread come within this long, so older mail isn't looked at.
const LOOK_BACK_MS = 60 * 86_400_000;

// Files buyers' emails on their threads, by matchShopifyReply. Safe to run
// again: each email is one message. One filed is done in the mailbox, since
// it's answered from the thread; one left unmatched stays there to be read.
export async function threadShopifyMail(db: Db) {
	const rows = await db
		.select({
			id: buyerThreads.id,
			doneAt: buyerThreads.doneAt,
			createdAt: buyerThreads.createdAt,
			email: orders.buyerEmail,
			orderName: orders.name,
		})
		.from(buyerThreads)
		.innerJoin(stores, eq(stores.channel, buyerThreads.market))
		.innerJoin(
			orders,
			and(
				eq(orders.storeId, stores.id),
				eq(orders.externalId, buyerThreads.orderRef),
			),
		)
		.where(eq(buyerThreads.market, "shopify"));
	const threads = rows.flatMap((t) =>
		t.email
			? [
					{
						id: t.id,
						email: t.email,
						orderName: t.orderName,
						open: !t.doneAt,
						createdAt: t.createdAt,
					},
				]
			: [],
	);
	const senders = [...new Set(threads.map((t) => t.email))];
	if (senders.length === 0) return { filed: 0, unmatched: 0 };
	const pending = await db
		.select({
			id: marketEmails.id,
			messageId: marketEmails.messageId,
			fromAddress: marketEmails.fromAddress,
			recipients: marketEmails.recipients,
			subject: marketEmails.subject,
			body: marketEmails.body,
			receivedAt: marketEmails.receivedAt,
		})
		.from(marketEmails)
		.leftJoin(buyerMessages, eq(buyerMessages.marketEmailId, marketEmails.id))
		.where(
			and(
				isNull(marketEmails.market),
				inArray(marketEmails.fromAddress, senders),
				gte(marketEmails.receivedAt, new Date(Date.now() - LOOK_BACK_MS)),
				isNull(buyerMessages.id),
			),
		)
		.orderBy(marketEmails.receivedAt);
	const media = await mediaOf(
		db,
		pending.map((e) => e.id),
	);
	let filed = 0;
	let unmatched = 0;
	for (const e of pending) {
		const match = matchShopifyReply(e, threads);
		if (match.threadId === null) {
			unmatched++;
			continue;
		}
		const { threadId } = match;
		const added = await db.transaction(async (tx) => {
			const kept = await recordFromBuyer(tx, threadId, {
				externalId: e.messageId,
				body: replyText(e.body),
				at: e.receivedAt,
				marketEmailId: e.id,
				media: media(e.id),
			});
			await tx
				.update(marketEmails)
				.set({ doneAt: new Date() })
				.where(and(eq(marketEmails.id, e.id), isNull(marketEmails.doneAt)));
			return kept;
		});
		if (added) filed++;
	}
	return { filed, unmatched };
}
