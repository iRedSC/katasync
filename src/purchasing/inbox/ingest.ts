import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	poEmailAttachments,
	poEmails,
	purchaseOrders,
	purchaseOrderTracking,
	suppliers,
} from "#/db/schema";
import { pointPictures } from "#/inbox/html";
import { groupBy } from "#/lib/group-by";
import { PurchaseOrderError } from "#/purchasing/orders";
import { addTracking } from "#/purchasing/tracking";
import {
	type InboxAttachment,
	type InboxMessage,
	type InlinePicture,
	messageContent,
	poOfAddress,
} from "./graph";
import { isPdf, pdfText } from "./pdf-text";
import { findTracking } from "./tracking-numbers";

// Puts emails from the purchasing inbox on their POs. An email is matched
// only by something it can't have by accident: the PO's own reply address,
// or a subject naming "Purchase order 1234" sent from that PO's supplier's
// domain. Anything else waits, unfiled, for someone (or Claude) to file or set
// aside. Filing never changes the PO itself.

// An email's text and files, and, when the reader gives them, its HTML and
// the pictures inside it.
type Content = {
	body: string;
	attachments: InboxAttachment[];
	html?: string;
	inline?: InlinePicture[];
};
export type ReadContent = (graphId: string) => Promise<Content>;

// POs that have been sent: a draft has no supplier conversation yet.
const ON_ORDER = ["sent", "closed", "cancelled"] as const;
type Match = { purchaseOrderId: number; matchedBy: "address" | "subject" };
// The sent POs a batch names, each with its supplier's email.
export type SentPos = Map<number, string | null>;
// Ids per query, so a big batch doesn't make one huge IN list.
const IDS_PER_QUERY = 500;

const domainOf = (address: string | null | undefined) =>
	address?.trim().toLowerCase().split("@")[1] ?? null;

// The POs an email names: by its reply address, and by its subject.
function namedIn(email: Pick<InboxMessage, "recipients" | "subject">) {
	const byAddress = email.recipients
		.map(poOfAddress)
		.filter((id): id is number => id !== null);
	const bySubject = [
		...email.subject.matchAll(/purchase\s+order\s*#?\s*(\d{1,9})\b/gi),
	].map((m) => Number(m[1]));
	return { byAddress, bySubject };
}

// Reads the sent POs that a batch of emails names, once for the whole batch.
export async function sentPosOf(
	db: Db,
	emails: Pick<InboxMessage, "recipients" | "subject">[],
): Promise<SentPos> {
	const ids = [
		...new Set(
			emails.flatMap((e) => {
				const { byAddress, bySubject } = namedIn(e);
				return [...byAddress, ...bySubject];
			}),
		),
	];
	const sent: SentPos = new Map();
	for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
		const rows = await db
			.select({
				id: purchaseOrders.id,
				status: purchaseOrders.status,
				supplierEmail: suppliers.email,
			})
			.from(purchaseOrders)
			.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
			.where(inArray(purchaseOrders.id, ids.slice(i, i + IDS_PER_QUERY)));
		for (const p of rows) {
			if ((ON_ORDER as readonly string[]).includes(p.status))
				sent.set(p.id, p.supplierEmail);
		}
	}
	return sent;
}

// Which PO an email is filed on, from the batch's sent POs.
export function matchEmail(
	sent: SentPos,
	email: Pick<InboxMessage, "recipients" | "subject" | "fromAddress">,
): Match | null {
	const { byAddress, bySubject } = namedIn(email);
	// An email naming two POs is about neither for sure: it waits for a person.
	const addressed = [...new Set(byAddress.filter((id) => sent.has(id)))];
	if (addressed.length > 1) return null;
	if (addressed.length === 1)
		return { purchaseOrderId: addressed[0], matchedBy: "address" };
	const fromDomain = domainOf(email.fromAddress);
	const subjects = [
		...new Set(
			bySubject.filter(
				(id) => fromDomain && domainOf(sent.get(id)) === fromDomain,
			),
		),
	];
	return subjects.length === 1
		? { purchaseOrderId: subjects[0], matchedBy: "subject" }
		: null;
}

// Takes an email's packages off any PO it has left. A move can land while the
// lookups above are running, so this runs after them, with the email locked.
async function dropStaleTracking(db: Db, emailId: number) {
	await db.transaction(async (tx) => {
		const [email] = await tx
			.select({ purchaseOrderId: poEmails.purchaseOrderId })
			.from(poEmails)
			.where(eq(poEmails.id, emailId))
			.for("update");
		const owner = email?.purchaseOrderId ?? null;
		await tx
			.delete(purchaseOrderTracking)
			.where(
				and(
					eq(purchaseOrderTracking.emailId, emailId),
					owner === null
						? undefined
						: ne(purchaseOrderTracking.purchaseOrderId, owner),
				),
			);
	});
}

// Follows the tracking numbers in an email on its PO. Never throws: a PO
// that can't take tracking or a Shippo outage leaves the email filed.
async function trackFrom(
	db: Db,
	email: { id: number; subject: string; body: string },
	purchaseOrderId: number,
) {
	const problems: string[] = [];
	const found = findTracking(`${email.subject}\n${email.body}`);
	for (const t of found) {
		try {
			const added = await addTracking(db, {
				purchaseOrderId,
				...t,
				emailId: email.id,
			});
			if (added.added && added.problem) problems.push(added.problem);
		} catch (error) {
			if (!(error instanceof PurchaseOrderError)) throw error;
		}
	}
	if (found.length > 0) await dropStaleTracking(db, email.id);
	return problems;
}

async function save(
	db: Db,
	message: InboxMessage,
	content: Content,
	match: Match | null,
) {
	const files = await Promise.all(
		content.attachments.map(async (a) => ({
			...a,
			text:
				a.data && isPdf(a.contentType, a.filename)
					? await pdfText(a.data)
					: null,
		})),
	);
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(poEmails)
			.values({
				messageId: message.messageId,
				purchaseOrderId: match?.purchaseOrderId ?? null,
				matchedBy: match?.matchedBy ?? null,
				fromAddress: message.fromAddress,
				fromName: message.fromName,
				recipients: message.recipients,
				subject: message.subject,
				body: content.body,
				receivedAt: message.receivedAt,
			})
			// Another run read it first.
			.onConflictDoNothing()
			.returning();
		if (!row) return null;
		if (files.length > 0)
			await tx.insert(poEmailAttachments).values(
				files.map((f) => ({
					emailId: row.id,
					filename: f.filename,
					contentType: f.contentType,
					size: f.size,
					data: f.data,
					text: f.text,
				})),
			);
		if (content.html !== undefined)
			await keepHtml(tx, row.id, content.html, content.inline ?? []);
		return row;
	});
}

// Reads in the emails not already kept, files the ones that match, and
// follows their tracking. With retrack (the sweep), also follows tracking in
// kept emails on their POs again, in case a run stopped between saving an
// email and its tracking; numbers already followed are left alone. Returns
// what it did, for the cron's log.
export async function ingest(
	db: Db,
	messages: InboxMessage[],
	read: ReadContent = messageContent,
	{ retrack = false } = {},
) {
	if (messages.length === 0) return { read: 0, filed: 0, problems: [] };
	const kept = await db
		.select({
			id: poEmails.id,
			messageId: poEmails.messageId,
			purchaseOrderId: poEmails.purchaseOrderId,
			subject: poEmails.subject,
			body: poEmails.body,
		})
		.from(poEmails)
		.where(
			inArray(
				poEmails.messageId,
				messages.map((m) => m.messageId),
			),
		);
	const known = new Set(kept.map((r) => r.messageId));
	const sent = await sentPosOf(
		db,
		messages.filter((m) => !known.has(m.messageId)),
	);
	let read_ = 0;
	let filed = 0;
	const problems: string[] = [];
	if (retrack)
		for (const e of kept)
			if (e.purchaseOrderId !== null)
				problems.push(...(await trackFrom(db, e, e.purchaseOrderId)));
	for (const message of messages) {
		if (known.has(message.messageId)) continue;
		known.add(message.messageId);
		try {
			const content = await read(message.graphId);
			const match = matchEmail(sent, message);
			const row = await save(db, message, content, match);
			if (!row) continue;
			read_++;
			if (match) {
				filed++;
				problems.push(...(await trackFrom(db, row, match.purchaseOrderId)));
			}
		} catch (error) {
			problems.push(
				`${message.subject || message.messageId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { read: read_, filed, problems };
}

async function emailRow(db: Db, id: number) {
	const [row] = await db.select().from(poEmails).where(eq(poEmails.id, id));
	if (!row) throw new PurchaseOrderError(`There's no email ${id}`);
	return row;
}

// The email's row, locked until the transaction ends, so its PO can't change
// under it.
async function lockedEmail(tx: Db, id: number) {
	const [row] = await tx
		.select()
		.from(poEmails)
		.where(eq(poEmails.id, id))
		.for("update");
	if (!row) throw new PurchaseOrderError(`There's no email ${id}`);
	return row;
}

// Files an email on a PO, or moves it to another, and follows its tracking
// there. Null takes it off its PO, back to unfiled.
export async function fileEmail(
	db: Db,
	input: {
		emailId: number;
		purchaseOrderId: number | null;
		by: "staff" | "claude";
	},
) {
	if (input.purchaseOrderId !== null) {
		const [po] = await db
			.select({ status: purchaseOrders.status })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.id, input.purchaseOrderId));
		if (!po)
			throw new PurchaseOrderError(`There's no PO ${input.purchaseOrderId}`);
		if (!(ON_ORDER as readonly string[]).includes(po.status))
			throw new PurchaseOrderError(
				`PO ${input.purchaseOrderId} hasn't been sent, so no email is about it yet`,
			);
	}
	const email = await db.transaction(async (tx) => {
		const before = await lockedEmail(tx, input.emailId);
		await tx
			.update(poEmails)
			.set({
				purchaseOrderId: input.purchaseOrderId,
				matchedBy: input.purchaseOrderId === null ? null : input.by,
				setAsideAt: null,
			})
			.where(eq(poEmails.id, input.emailId));
		// Its packages go with it: the old PO stops following them.
		if (
			before.purchaseOrderId !== null &&
			before.purchaseOrderId !== input.purchaseOrderId
		)
			await tx
				.delete(purchaseOrderTracking)
				.where(
					and(
						eq(purchaseOrderTracking.emailId, before.id),
						eq(purchaseOrderTracking.purchaseOrderId, before.purchaseOrderId),
					),
				);
		return before;
	});
	const problems =
		input.purchaseOrderId === null
			? []
			: await trackFrom(db, email, input.purchaseOrderId);
	return {
		id: email.id,
		was: email.purchaseOrderId,
		purchaseOrderId: input.purchaseOrderId,
		problems,
	};
}

// About no PO (a newsletter, a quote request). Undone by setAside(…, false).
// Read on the Inbox page, or back to unread.
export async function setRead(db: Db, emailId: number, read: boolean) {
	await emailRow(db, emailId);
	await db
		.update(poEmails)
		.set({ readAt: read ? new Date() : null })
		.where(eq(poEmails.id, emailId));
	return { id: emailId, read };
}

export async function setAside(db: Db, emailId: number, aside = true) {
	const email = await emailRow(db, emailId);
	if (email.purchaseOrderId !== null)
		throw new PurchaseOrderError(
			`Email ${emailId} is on PO ${email.purchaseOrderId}; take it off first`,
		);
	await db
		.update(poEmails)
		.set({ setAsideAt: aside ? new Date() : null })
		.where(eq(poEmails.id, emailId));
	return { id: emailId, setAside: aside };
}

// Reads one email from the mailbox into katasync, e.g. one from before the
// inbox was connected, and puts it on the PO given, or unfiled for null, as
// fileEmail does for a kept one.
export async function importEmail(
	db: Db,
	message: InboxMessage,
	purchaseOrderId: number | null,
	read: ReadContent = messageContent,
) {
	const [existing] = await db
		.select({ id: poEmails.id })
		.from(poEmails)
		.where(eq(poEmails.messageId, message.messageId));
	let id = existing?.id;
	if (!id) {
		// Saved unfiled; fileEmail decides where it goes.
		const row = await save(db, message, await read(message.graphId), null);
		id =
			row?.id ??
			(
				await db
					.select({ id: poEmails.id })
					.from(poEmails)
					.where(eq(poEmails.messageId, message.messageId))
			)[0].id;
	}
	return fileEmail(db, { emailId: id, purchaseOrderId, by: "claude" });
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

// Which emails the inbox page lists: waiting to be filed, set aside as about
// no PO, or already on a PO.
export type InboxView = "to-file" | "set-aside" | "filed";

// One of the inbox page's lists, newest first, each email with the supplier
// of the PO it's on.
export async function inboxEmails(db: Db, view: InboxView, limit = 100) {
	const rows = await db
		.select({ ...summary, body: poEmails.body, poSupplier: suppliers.name })
		.from(poEmails)
		.leftJoin(purchaseOrders, eq(purchaseOrders.id, poEmails.purchaseOrderId))
		.leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
		.where(
			view === "filed"
				? isNotNull(poEmails.purchaseOrderId)
				: and(
						isNull(poEmails.purchaseOrderId),
						view === "set-aside"
							? isNotNull(poEmails.setAsideAt)
							: isNull(poEmails.setAsideAt),
					),
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

// Keeps an email's HTML, with its pictures kept and pointed at.
async function keepHtml(
	db: Db,
	emailId: number,
	html: string,
	inline: InlinePicture[],
) {
	const kept =
		inline.length === 0
			? []
			: await db
					.insert(poEmailAttachments)
					.values(
						inline.map((p) => ({
							emailId,
							filename: p.filename,
							contentType: p.contentType,
							size: p.size,
							data: p.data,
							contentId: p.contentId,
						})),
					)
					.returning({
						id: poEmailAttachments.id,
						contentId: poEmailAttachments.contentId,
					});
	await db
		.update(poEmails)
		.set({
			bodyHtml: pointPictures(
				html,
				kept.map((k) => ({
					contentId: k.contentId ?? "",
					url: `/api/po-email-attachments/${k.id}`,
				})),
			),
		})
		.where(eq(poEmails.id, emailId));
}

// Fetches the HTML of emails kept before katasync kept it, newest first, a
// few a run. One gone from the mailbox keeps its text only (empty HTML).
export async function backfillHtml(
	db: Db,
	read: (
		messageId: string,
	) => Promise<{ html: string; inline: InlinePicture[] } | null>,
	limit = 25,
) {
	const rows = await db
		.select({ id: poEmails.id, messageId: poEmails.messageId })
		.from(poEmails)
		.where(isNull(poEmails.bodyHtml))
		.orderBy(desc(poEmails.receivedAt))
		.limit(limit);
	for (const r of rows) {
		// A failure leaves it for the next run.
		const found = await read(r.messageId).catch(() => undefined);
		if (found === undefined) continue;
		await db.transaction((tx) =>
			keepHtml(tx, r.id, found?.html ?? "", found?.inline ?? []),
		);
	}
	return rows.length;
}

// The HTML of one email, for reading it formatted.
export async function emailHtml(db: Db, id: number) {
	const [row] = await db
		.select({ html: poEmails.bodyHtml })
		.from(poEmails)
		.where(eq(poEmails.id, id));
	return row?.html || null;
}
