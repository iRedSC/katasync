import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	buyerMessages,
	buyerThreads,
	marketEmails,
	orderBuyerContacts,
	orders,
	stores,
} from "#/db/schema";
import { mediaOf } from "./amazon-mail";
import { sendWithResend } from "./resend";
import {
	type BuyerOrderRef,
	inbox,
	matchShopifyReply,
	replyText,
	type ShopifyThreadRef,
	threadAddress,
} from "./shopify-match";
import { Refused } from "./states";
import { ensureThread, recordFromBuyer } from "./threads";

// Emailing the buyers of Shopify's own orders, who have no marketplace chat:
// staff start a thread from the order, Resend sends it from the
// marketplaces mailbox (MARKETPLACE_INBOX, as Amazon replies go), and its
// Reply-To is the thread's own signed address there (./shopify-match.ts),
// so the answer is read in with the rest of that mailbox and filed back on
// the thread. A relayed TikTok order's buyer is TikTok's, so it never gets
// one. Shopify Inbox, the storefront's web chat, is apart from this: it has
// no public API.

const STORE_NAME = "East Coast Drywall Tools";

// Why Shopify buyers can't be emailed yet, or null when they can.
export function emailUnready() {
	const missing = [
		!process.env.RESEND_API_KEY && "RESEND_API_KEY",
		!inbox() && "MARKETPLACE_INBOX",
		!process.env.CRON_SECRET && "CRON_SECRET",
	].filter(Boolean);
	return missing.length > 0 ? `Set ${missing.join(", ")}` : null;
}

// The thread for an order, made the first time someone emails its buyer,
// and opened again if someone was done with it.
export async function startShopifyThread(db: Db, orderId: number) {
	const [o] = await db
		.select({
			externalId: orders.externalId,
			name: orders.name,
			customerName: orders.customerName,
			buyerEmail: orderBuyerContacts.email,
			marketplaceOrderId: orders.marketplaceOrderId,
			channel: stores.channel,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.leftJoin(orderBuyerContacts, eq(orderBuyerContacts.orderId, orders.id))
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
				.select({ email: orderBuyerContacts.email })
				.from(orders)
				.innerJoin(stores, eq(stores.id, orders.storeId))
				.innerJoin(
					orderBuyerContacts,
					eq(orderBuyerContacts.orderId, orders.id),
				)
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
	const box = inbox();
	const replyTo = threadAddress(r.threadId);
	if (!process.env.RESEND_API_KEY || !box || !replyTo)
		throw new Refused(emailUnready() ?? "Not set up");
	return sendWithResend({
		...r,
		from: `${STORE_NAME} <${box}>`,
		replyTo,
		subject:
			r.inReplyTo && !/^re:/i.test(r.subject) ? `Re: ${r.subject}` : r.subject,
	});
}

// Replies to a thread come within this long, so older mail isn't looked at.
const LOOK_BACK_MS = 60 * 86_400_000;

// Files buyers' emails on their threads, by matchShopifyReply. Safe to run
// again: each email is one message. One filed is done in the mailbox, since
// it's answered from the thread; one left unmatched (an unverified sender
// among them) stays there to be read.
export async function threadShopifyMail(db: Db) {
	const rows = await db
		.select({
			id: buyerThreads.id,
			doneAt: buyerThreads.doneAt,
			createdAt: buyerThreads.createdAt,
			email: orderBuyerContacts.email,
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
		.innerJoin(orderBuyerContacts, eq(orderBuyerContacts.orderId, orders.id))
		.where(eq(buyerThreads.market, "shopify"));
	const threads: ShopifyThreadRef[] = rows.map((t) => ({
		id: t.id,
		email: t.email,
		orderName: t.orderName,
		open: !t.doneAt,
		createdAt: t.createdAt,
	}));
	const senders = [...new Set(threads.map((t) => t.email))];
	if (senders.length === 0) return { filed: 0, unmatched: 0 };
	// Every order of theirs, threaded or not, so naming one without a
	// conversation is known for what it is.
	const buyerOrders: BuyerOrderRef[] = await db
		.select({ email: orderBuyerContacts.email, name: orders.name })
		.from(orderBuyerContacts)
		.innerJoin(orders, eq(orders.id, orderBuyerContacts.orderId))
		.where(inArray(orderBuyerContacts.email, senders));
	const pending = await db
		.select({
			id: marketEmails.id,
			messageId: marketEmails.messageId,
			fromAddress: marketEmails.fromAddress,
			senderAuthenticated: marketEmails.senderAuthenticated,
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
		const match = matchShopifyReply(e, threads, buyerOrders);
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
