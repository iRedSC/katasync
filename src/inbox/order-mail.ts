import { and, desc, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { marketEmailAttachments, marketEmails } from "#/db/schema";
import { groupBy } from "#/lib/group-by";
import type { Market } from "#/markets/market";
import { type OrderRef, orderRefs } from "./mail-orders";

// The mail about one order, for its page: marketplace emails that name it.
// The reverse of mail-orders.ts, and
// held to the same reading of an email: a text search finds candidates, and
// only the ones orderRefs reads this order's number in are kept, so "#574"
// never brings in #5747's emails. Server only.

type Order = {
	channel: Market;
	name: string;
	externalId: string;
	marketplaceOrderId: string | null;
};

// Most emails shown; the newest win.
const MOST_EMAILS = 20;

// Every number an email might name the order by, as orderRefs reads them.
export function refsOf(o: Order): OrderRef[] {
	const refs: OrderRef[] = [{ market: o.channel, by: "id", ref: o.externalId }];
	if (o.channel === "shopify")
		refs.push({ market: "shopify", by: "name", ref: o.name });
	const relayed = /^([a-z]+):(.+)$/.exec(o.marketplaceOrderId ?? "");
	if (relayed)
		refs.push({ market: relayed[1] as Market, by: "id", ref: relayed[2] });
	return refs;
}

// The text that has to appear for an email to name the ref. Shopify's ID
// shows as the number at the end of an admin link.
const needle = (r: OrderRef) =>
	r.by === "id" && r.ref.startsWith("gid://")
		? `/orders/${r.ref.split("/").pop()}`
		: r.ref;

const same = (a: OrderRef, b: OrderRef) =>
	a.market === b.market && a.by === b.by && a.ref === b.ref;

export async function orderMail(db: Db, order: Order) {
	const refs = refsOf(order);
	const likes = refs.map((r) => {
		const like = `%${needle(r).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		return or(
			ilike(marketEmails.subject, like),
			ilike(marketEmails.body, like),
		);
	});
	const candidates = await db
		.select({
			id: marketEmails.id,
			market: marketEmails.market,
			folder: marketEmails.folder,
			fromName: marketEmails.fromName,
			fromAddress: marketEmails.fromAddress,
			subject: marketEmails.subject,
			body: marketEmails.body,
			receivedAt: marketEmails.receivedAt,
			important: marketEmails.important,
			critical: marketEmails.critical,
		})
		.from(marketEmails)
		.where(or(...likes))
		.orderBy(desc(marketEmails.receivedAt))
		.limit(MOST_EMAILS * 3);
	const emails = candidates
		.filter((e) =>
			orderRefs(`${e.subject}\n${e.body}`, e.market).some((found) =>
				refs.some((r) => same(r, found)),
			),
		)
		.slice(0, MOST_EMAILS);
	// Their files, as the inbox lists them: inline pictures are part of the
	// message, not files of their own.
	const files =
		emails.length === 0
			? []
			: await db
					.select({
						id: marketEmailAttachments.id,
						emailId: marketEmailAttachments.emailId,
						filename: marketEmailAttachments.filename,
						contentType: marketEmailAttachments.contentType,
						size: marketEmailAttachments.size,
						kept: sql<boolean>`${marketEmailAttachments.data} is not null`,
					})
					.from(marketEmailAttachments)
					.where(
						and(
							inArray(
								marketEmailAttachments.emailId,
								emails.map((e) => e.id),
							),
							isNull(marketEmailAttachments.contentId),
						),
					)
					.orderBy(marketEmailAttachments.id);
	const byEmail = groupBy(files, (f) => f.emailId);

	return {
		emails: emails.map((e) => ({
			...e,
			attachments: (byEmail.get(e.id) ?? []).map(({ emailId: _, ...f }) => f),
		})),
	};
}

export type OrderMail = Awaited<ReturnType<typeof orderMail>>;
