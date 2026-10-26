import { eq, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { marketEmailAttachments, marketEmails } from "#/db/schema";
import type { InlinePicture } from "#/purchasing/inbox/graph";
import { pointPictures } from "../html";

export async function marketAttachment(db: Db, id: number) {
	const [file] = await db
		.select()
		.from(marketEmailAttachments)
		.where(eq(marketEmailAttachments.id, id));
	return file ?? null;
}

// Keeps an email's HTML, with its pictures kept and pointed at.
export async function keepHtml(
	db: Db,
	emailId: number,
	html: string,
	inline: InlinePicture[],
) {
	const kept =
		inline.length === 0
			? []
			: await db
					.insert(marketEmailAttachments)
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
						id: marketEmailAttachments.id,
						contentId: marketEmailAttachments.contentId,
					});
	await db
		.update(marketEmails)
		.set({
			bodyHtml: pointPictures(
				html,
				kept.map((k) => ({
					contentId: k.contentId ?? "",
					url: `/api/market-email-attachments/${k.id}`,
				})),
			),
		})
		.where(eq(marketEmails.id, emailId));
}

// Fetches the HTML of emails kept before katasync kept it, a few a run. One
// gone from the mailbox keeps its text only (empty HTML). The few are picked
// at random, so one that keeps failing can't hold back the rest; they're
// written newest first. Returns how many had their HTML saved; a failure isn't
// counted.
export async function backfillMarketHtml(
	db: Db,
	read: (
		messageId: string,
	) => Promise<{ html: string; inline: InlinePicture[] } | null>,
	limit = 25,
) {
	const rows = (
		await db
			.select({
				id: marketEmails.id,
				messageId: marketEmails.messageId,
				receivedAt: marketEmails.receivedAt,
			})
			.from(marketEmails)
			.where(isNull(marketEmails.bodyHtml))
			.orderBy(sql`random()`)
			.limit(limit)
	).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
	let saved = 0;
	for (const r of rows) {
		try {
			const found = await read(r.messageId);
			await db.transaction((tx) =>
				keepHtml(tx, r.id, found?.html ?? "", found?.inline ?? []),
			);
			saved++;
		} catch {
			// A failure leaves it for the next run.
		}
	}
	return saved;
}

export async function marketEmailHtml(db: Db, id: number) {
	const [row] = await db
		.select({ html: marketEmails.bodyHtml })
		.from(marketEmails)
		.where(eq(marketEmails.id, id));
	return row?.html || null;
}

// One kept email's HTML from the mailbox, or null when it's gone.
export async function readHtml(
	graph: typeof import("#/purchasing/inbox/graph"),
	messageId: string,
	box: "purchasing" | "marketplaces",
) {
	const id = await graph.findMessage(messageId, box);
	if (!id) return null;
	const { html, inline } = await graph.messageHtml(id, box);
	return { html, inline };
}
