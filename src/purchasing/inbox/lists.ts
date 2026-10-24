import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	poEmailAi,
	poEmailAttachments,
	poEmails,
	purchaseOrders,
	suppliers,
} from "#/db/schema";
import { groupBy } from "#/lib/group-by";
import { PurchaseOrderError } from "#/purchasing/orders";

// Reading kept emails back: a PO's, the inbox page's lists and counts, and
// one email with its files. Filing them is ingest.ts's.

export async function emailRow(db: Db, id: number) {
	const [row] = await db.select().from(poEmails).where(eq(poEmails.id, id));
	if (!row) throw new PurchaseOrderError(`There's no email ${id}`);
	return row;
}

const summary = {
	id: poEmails.id,
	purchaseOrderId: poEmails.purchaseOrderId,
	matchedBy: poEmails.matchedBy,
	setAsideAt: poEmails.setAsideAt,
	readAt: poEmails.readAt,
	fromAddress: poEmails.fromAddress,
	fromName: poEmails.fromName,
	subject: poEmails.subject,
	receivedAt: poEmails.receivedAt,
};

const attachmentSummary = {
	id: poEmailAttachments.id,
	emailId: poEmailAttachments.emailId,
	filename: poEmailAttachments.filename,
	contentType: poEmailAttachments.contentType,
	size: poEmailAttachments.size,
	kept: sql<boolean>`${poEmailAttachments.data} is not null`,
	hasText: sql<boolean>`${poEmailAttachments.text} is not null`,
	sha256: poEmailAttachments.sha256,
	// Taken off its PO's files; the email still shows it.
	removedAt: poEmailAttachments.removedAt,
};

async function withAttachments<T extends { id: number }>(db: Db, emails: T[]) {
	if (emails.length === 0) return [];
	const files = await db
		.select(attachmentSummary)
		.from(poEmailAttachments)
		.where(
			and(
				inArray(
					poEmailAttachments.emailId,
					emails.map((e) => e.id),
				),
				isNull(poEmailAttachments.contentId),
			),
		)
		.orderBy(poEmailAttachments.id);
	const byEmail = groupBy(files, (f) => f.emailId);
	return emails.map((e) => ({
		...e,
		attachments: (byEmail.get(e.id) ?? []).map(({ emailId: _, ...f }) => f),
	}));
}

// A PO's emails, newest first, with their bodies.
export async function emailsOf(db: Db, purchaseOrderId: number) {
	const rows = await db
		.select({ ...summary, body: poEmails.body })
		.from(poEmails)
		.where(eq(poEmails.purchaseOrderId, purchaseOrderId))
		.orderBy(desc(poEmails.receivedAt));
	return withAttachments(db, rows);
}

// A PO's emails, newest first, without their bodies, for summaries.
export async function emailSummariesOf(db: Db, purchaseOrderId: number) {
	const rows = await db
		.select(summary)
		.from(poEmails)
		.where(eq(poEmails.purchaseOrderId, purchaseOrderId))
		.orderBy(desc(poEmails.receivedAt));
	return withAttachments(db, rows);
}

// Emails waiting to be filed, newest first; set-aside ones too if asked.
export async function unfiledEmails(
	db: Db,
	options: { setAside?: boolean; limit?: number } = {},
) {
	const rows = await db
		.select({ ...summary, body: poEmails.body })
		.from(poEmails)
		.where(
			and(
				isNull(poEmails.purchaseOrderId),
				options.setAside ? undefined : isNull(poEmails.setAsideAt),
			),
		)
		.orderBy(desc(poEmails.receivedAt))
		.limit(options.limit ?? 100);
	return withAttachments(db, rows);
}

// Which emails the inbox page lists: waiting to be filed, or decided: on a
// PO or set aside as about no PO.
export type InboxView = "unfiled" | "filed";

const original = alias(poEmails, "original");

// One of the inbox page's lists, newest first, each email with the supplier
// of the PO it's on.
export async function inboxEmails(db: Db, view: InboxView, limit = 100) {
	const rows = await db
		.select({
			...summary,
			body: poEmails.body,
			poSupplier: suppliers.name,
			// What the AI made of it (src/purchasing/inbox/ai-filing.ts).
			ai: {
				state: poEmailAi.state,
				purchaseOrderId: poEmailAi.purchaseOrderId,
				reason: poEmailAi.reason,
				proposal: poEmailAi.proposal,
				applied: poEmailAi.applied,
			},
			// The earlier email the AI set it aside as a copy of.
			original: {
				id: original.id,
				subject: original.subject,
				receivedAt: original.receivedAt,
				purchaseOrderId: original.purchaseOrderId,
			},
		})
		.from(poEmails)
		.leftJoin(purchaseOrders, eq(purchaseOrders.id, poEmails.purchaseOrderId))
		.leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
		.leftJoin(poEmailAi, eq(poEmailAi.emailId, poEmails.id))
		.leftJoin(original, eq(original.id, poEmailAi.duplicateOf))
		.where(
			view === "filed"
				? or(
						isNotNull(poEmails.purchaseOrderId),
						isNotNull(poEmails.setAsideAt),
					)
				: and(isNull(poEmails.purchaseOrderId), isNull(poEmails.setAsideAt)),
		)
		.orderBy(desc(poEmails.receivedAt))
		.limit(limit);
	return withAttachments(db, rows);
}

// Emails not on a PO, waiting and set aside, and of those how many are
// unread (what the Inbox page counts).
export async function countUnfiled(db: Db) {
	const unread = sql`${poEmails.readAt} is null`;
	const [row] = await db
		.select({
			toFile: sql<number>`count(*) filter (where ${poEmails.setAsideAt} is null)::int`,
			setAside: sql<number>`count(*) filter (where ${poEmails.setAsideAt} is not null)::int`,
			toFileUnread: sql<number>`count(*) filter (where ${poEmails.setAsideAt} is null and ${unread})::int`,
			setAsideUnread: sql<number>`count(*) filter (where ${poEmails.setAsideAt} is not null and ${unread})::int`,
		})
		.from(poEmails)
		.where(isNull(poEmails.purchaseOrderId));
	return row;
}

// An email with its files' names, sizes, and text, but not their bytes: read
// one of those with attachmentOf.
export async function emailWithFiles(db: Db, id: number) {
	const email = await emailRow(db, id);
	const files = await db
		.select({
			id: poEmailAttachments.id,
			filename: poEmailAttachments.filename,
			contentType: poEmailAttachments.contentType,
			size: poEmailAttachments.size,
			text: poEmailAttachments.text,
			kept: sql<boolean>`${poEmailAttachments.data} is not null`,
		})
		.from(poEmailAttachments)
		.where(
			and(
				eq(poEmailAttachments.emailId, id),
				isNull(poEmailAttachments.contentId),
			),
		)
		.orderBy(poEmailAttachments.id);
	return { email, files };
}

// One file of an email, with its bytes. Null unless the email has that file,
// so the bytes come only for a file asked for.
export async function attachmentOf(
	db: Db,
	emailId: number,
	attachmentId: number,
) {
	const [file] = await db
		.select()
		.from(poEmailAttachments)
		.where(
			and(
				eq(poEmailAttachments.id, attachmentId),
				eq(poEmailAttachments.emailId, emailId),
				isNull(poEmailAttachments.contentId),
			),
		);
	return file ?? null;
}

export async function attachmentFile(db: Db, id: number) {
	const [file] = await db
		.select()
		.from(poEmailAttachments)
		.where(eq(poEmailAttachments.id, id));
	return file ?? null;
}
