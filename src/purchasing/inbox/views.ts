import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseOrders, suppliers } from "#/db/schema";
import { groupBy } from "#/lib/group-by";
import { flagsOfEmails } from "#/purchasing/flags";
import { inboxAddress } from "./graph";
import {
	countUnfiled,
	type InboxView,
	inboxEmails,
	unfiledEmails,
} from "./ingest";

// Kept out of src/server/purchasing/inbox.ts: a server-function file that
// exports a plain function keeps its imports in the browser bundle, and
// those reach the stock ledger's node:crypto, which stops every page from
// starting.

const domain = (a: string | null) => a?.toLowerCase().split("@")[1] ?? null;

// PO numbers an email names: "PO 1234", "P.O. #1234", "order 1234", "#1234".
export function mentionedPos(text: string) {
	const found = new Set<number>();
	for (const m of text.matchAll(
		/(?:\bp\.?o\.?|\border|#)\s*#?\s*(\d{2,7})\b/gi,
	))
		found.add(Number(m[1]));
	return found;
}

// How sure we are an email is about a PO: it names the PO's number, or it's
// from the PO's supplier.
export type Likelihood = "mentions" | "supplier";

export function likelihood(
	email: { fromAddress: string; subject: string; body: string },
	po: { id: number; supplierEmail: string | null },
	mentions = mentionedPos(`${email.subject}\n${email.body}`),
): Likelihood | null {
	if (mentions.has(po.id)) return "mentions";
	const d = domain(po.supplierEmail);
	return d !== null && d === domain(email.fromAddress) ? "supplier" : null;
}

// POs an email can go on: sent in the last half year, newest first.
export function recentPos(db: Db) {
	return db
		.select({
			id: purchaseOrders.id,
			sentAt: purchaseOrders.sentAt,
			supplier: suppliers.name,
			supplierEmail: suppliers.email,
		})
		.from(purchaseOrders)
		.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
		.where(
			and(
				inArray(purchaseOrders.status, ["sent", "closed", "cancelled"]),
				gte(purchaseOrders.sentAt, new Date(Date.now() - 183 * 86_400_000)),
			),
		)
		.orderBy(desc(purchaseOrders.sentAt));
}

// One list of the inbox page, each email with the POs it's likely about
// (named in it first, then its supplier's), and how many wait in each list.
export async function inboxPage(db: Db, view: InboxView) {
	const [emails, pos, unfiled] = await Promise.all([
		inboxEmails(db, view),
		recentPos(db),
		countUnfiled(db),
	]);
	const flags = groupBy(
		await flagsOfEmails(
			db,
			emails.map((e) => e.id),
		),
		(f) => f.emailId,
	);
	return {
		connected: inboxAddress() !== null,
		// Unread, as the Inbox page counts.
		counts: { toFile: unfiled.toFileUnread, setAside: unfiled.setAsideUnread },
		emails: emails.map((e) => {
			const mentions = mentionedPos(`${e.subject}\n${e.body}`);
			const rank = (p: (typeof pos)[number]) => {
				const l = likelihood(e, p, mentions);
				return l === "mentions" ? 0 : l === "supplier" ? 1 : 2;
			};
			return {
				...e,
				// Those read from it on the PO it's on.
				flags: (flags.get(e.id) ?? []).filter(
					(f) => f.purchaseOrderId === e.purchaseOrderId,
				),
				likelyPos: pos
					.filter((p) => rank(p) < 2 && p.id !== e.purchaseOrderId)
					.sort((a, b) => rank(a) - rank(b))
					.map((p) => p.id),
			};
		}),
		pos: pos.map(({ supplierEmail: _, ...p }) => p),
	};
}

export type InboxPage = Awaited<ReturnType<typeof inboxPage>>;

// Unfiled emails that could go on this PO: those naming it first, then its
// supplier's, then the rest; set-aside ones after those waiting.
export async function emailsToLink(db: Db, purchaseOrderId: number) {
	const [[po], emails] = await Promise.all([
		db
			.select({ id: purchaseOrders.id, supplierEmail: suppliers.email })
			.from(purchaseOrders)
			.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
			.where(eq(purchaseOrders.id, purchaseOrderId)),
		unfiledEmails(db, { setAside: true, limit: 200 }),
	]);
	if (!po) return [];
	const order = { mentions: 0, supplier: 1 };
	const score = (e: { setAsideAt: Date | null; match: Likelihood | null }) =>
		(e.setAsideAt ? 10 : 0) + (e.match ? order[e.match] : 2);
	return emails
		.map((e) => ({ ...e, match: likelihood(e, po) }))
		.sort((a, b) => score(a) - score(b));
}

export type EmailToLink = Awaited<ReturnType<typeof emailsToLink>>[number];
