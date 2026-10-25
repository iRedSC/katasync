import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { orderSummary } from "#/buyers/order";
import type { Db } from "#/db/client";
import { marketEmails, orders, stores } from "#/db/schema";
import type { Market } from "#/markets/market";

// The orders a marketplace email names, found in katasync, for the top of
// the email as on a buyer's conversation. Looked up as it opens, so an order
// that syncs after the email still shows. Server only.

// A number as the email has it: a channel's own ID for the order, or the
// name it shows people (Shopify's "#5747").
export type OrderRef = { market: Market; by: "id" | "name"; ref: string };

const PATTERNS: {
	re: RegExp;
	ref: (m: RegExpExecArray) => OrderRef;
	// Only in this market's emails (or ones from no marketplace): too common
	// a shape to trust elsewhere.
	only?: Market;
}[] = [
	{
		re: /\b\d{3}-\d{7}-\d{7}\b/g,
		ref: (m) => ({ market: "amazon", by: "id", ref: m[0] }),
	},
	{
		re: /\b\d{2}-\d{5}-\d{5}\b/g,
		ref: (m) => ({ market: "ebay", by: "id", ref: m[0] }),
	},
	{
		re: /(?<!\d)\d{18}(?!\d)/g,
		ref: (m) => ({ market: "tiktok", by: "id", ref: m[0] }),
	},
	// Shopify's admin links to the order by its ID.
	{
		re: /\/orders\/(\d{10,})\b/g,
		ref: (m) => ({
			market: "shopify",
			by: "id",
			ref: `gid://shopify/Order/${m[1]}`,
		}),
	},
	{
		re: /#(\d{4,})\b/g,
		ref: (m) => ({ market: "shopify", by: "name", ref: `#${m[1]}` }),
		only: "shopify",
	},
];

// Most an email is searched for, so a daily summary listing hundreds stays
// one query.
const MOST_REFS = 50;
// Most shown, each asked of the carriers.
export const MOST_SHOWN = 6;

// Every order number in the text, once each, in the order they appear.
export function orderRefs(text: string, market: Market | null): OrderRef[] {
	const found: { at: number; ref: OrderRef }[] = [];
	for (const p of PATTERNS) {
		if (p.only && market !== null && market !== p.only) continue;
		for (const m of text.matchAll(p.re))
			found.push({ at: m.index, ref: p.ref(m) });
	}
	const seen = new Set<string>();
	return found
		.sort((a, b) => a.at - b.at)
		.map((f) => f.ref)
		.filter((r) => {
			const key = `${r.market}|${r.by}|${r.ref}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, MOST_REFS);
}

// A relayed order (TikTok's on Shopify) is found by the marketplace's ID too.
const matches = (r: OrderRef): SQL | undefined =>
	r.by === "name"
		? and(eq(stores.channel, r.market), eq(orders.name, r.ref))
		: or(
				and(eq(stores.channel, r.market), eq(orders.externalId, r.ref)),
				eq(orders.marketplaceOrderId, `${r.market}:${r.ref}`),
			);

export async function mailOrders(db: Db, emailId: number) {
	const [email] = await db
		.select({
			subject: marketEmails.subject,
			body: marketEmails.body,
			market: marketEmails.market,
			voicemail: marketEmails.voicemail,
		})
		.from(marketEmails)
		.where(eq(marketEmails.id, emailId));
	if (email?.voicemail) {
		const ids =
			email.voicemail.state === "ready" ? email.voicemail.orderIds : [];
		const found = ids.length
			? await db
					.select({ id: orders.id })
					.from(orders)
					.where(inArray(orders.id, ids))
			: [];
		return {
			orders: await Promise.all(
				found.map((order) => orderSummary(db, order.id)),
			),
			more: 0,
		};
	}
	const refs = email
		? orderRefs(`${email.subject}\n${email.body}`, email.market)
		: [];
	if (refs.length === 0) return { orders: [], more: 0 };
	const rows = await db
		.select({
			id: orders.id,
			name: orders.name,
			market: stores.channel,
			externalId: orders.externalId,
			marketplaceOrderId: orders.marketplaceOrderId,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(or(...refs.map(matches)));
	// As the email names them.
	const place = (o: (typeof rows)[number]) =>
		refs.findIndex((r) =>
			r.by === "name"
				? r.market === o.market && r.ref === o.name
				: (r.market === o.market && r.ref === o.externalId) ||
					`${r.market}:${r.ref}` === o.marketplaceOrderId,
		);
	const found = rows.sort((a, b) => place(a) - place(b));
	return {
		orders: await Promise.all(
			found.slice(0, MOST_SHOWN).map((o) => orderSummary(db, o.id)),
		),
		more: Math.max(0, found.length - MOST_SHOWN),
	};
}

export type MailOrders = Awaited<ReturnType<typeof mailOrders>>;
