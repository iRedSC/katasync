import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	mailboxChecks,
	marketEmailAttachments,
	marketEmailLabel,
	marketEmails,
} from "#/db/schema";
import type { Market } from "#/markets/market";
import type { InboxMessage, InlinePicture } from "#/purchasing/inbox/graph";
import type { ReadContent } from "#/purchasing/inbox/ingest";
import { pointPictures } from "./html";

// The marketplaces mailbox in katasync: each notice read in from Microsoft
// 365, sorted by marketplace and into a label, and worked through like a
// mail app (done, or moved to another label). Server only.

export type MarketLabel = (typeof marketEmailLabel.enumValues)[number];
export const MARKET_LABELS = marketEmailLabel.enumValues;

// Which marketplace an address belongs to, by its domain.
const SENDERS: [RegExp, Market][] = [
	[/(^|[.@])amazon\.[a-z.]+$/, "amazon"],
	[/(^|[.@])ebay\.[a-z.]+$/, "ebay"],
	[/(^|[.@])(tiktok|tiktokshop|tiktokglobalshop)\.[a-z.]+$/, "tiktok"],
	[/(^|[.@])shopify\.[a-z.]+$/, "shopify"],
];

export function marketOf(fromAddress: string): Market | null {
	const address = fromAddress.trim().toLowerCase();
	return SENDERS.find(([pattern]) => pattern.test(address))?.[1] ?? null;
}

// What needs someone, in the words marketplaces use for it. Checked first,
// so "dispute on order 123" is attention, not an order.
const ATTENTION =
	/\b(violat\w*|polic(y|ies)|suspend\w*|deactivat\w*|suppress\w*|remov(ed|al)|warning|action required|act now|account health|at risk|dispute\w*|chargeback\w*|claim\w*|a-to-z|appeal\w*|infring\w*|counterfeit|inauthentic|restrict\w*|blocked|frozen|freez\w*|reinstat\w*|penalt\w*|defect\w*|verif(y|ication)|activat\w*|document request|intellectual property|unpaid item|negative feedback|case)\b/i;
// Things coming back and money going back.
const RETURNS =
	/\b(returns?|returned|return request\w*|refund\w*|rma|replacement)\b/i;
// The day-to-day of selling.
const ORDERS =
	/\b(orders?|sold|you made a sale|ship(ped|ment|ping)?|deliver\w*|cancel\w*|buyer message|purchase)\b/i;

// Which label a new email gets. Only the subject decides: bodies carry
// footers ("see our return policy") that would sort everything as
// attention.
export function labelOf(subject: string): MarketLabel {
	if (ATTENTION.test(subject)) return "attention";
	if (RETURNS.test(subject)) return "returns";
	if (ORDERS.test(subject)) return "orders";
	return "updates";
}

// Reads new emails in: skips ones already kept, keeps each with its files,
// sorted. One that fails to read is reported and left for the next run.
export async function ingestMarketMail(
	db: Db,
	messages: InboxMessage[],
	read: ReadContent,
) {
	if (messages.length === 0) return { read: 0, problems: [] as string[] };
	const kept = await db
		.select({ messageId: marketEmails.messageId })
		.from(marketEmails)
		.where(
			inArray(
				marketEmails.messageId,
				messages.map((m) => m.messageId),
			),
		);
	const known = new Set(kept.map((k) => k.messageId));
	let count = 0;
	const problems: string[] = [];
	for (const m of messages) {
		if (known.has(m.messageId)) continue;
		known.add(m.messageId);
		try {
			const content = await read(m.graphId);
			await db.transaction(async (tx) => {
				const [row] = await tx
					.insert(marketEmails)
					.values({
						messageId: m.messageId,
						market: marketOf(m.fromAddress),
						label: labelOf(m.subject),
						fromAddress: m.fromAddress,
						fromName: m.fromName,
						recipients: m.recipients,
						subject: m.subject,
						body: content.body,
						receivedAt: m.receivedAt,
					})
					// Another run read it first.
					.onConflictDoNothing()
					.returning({ id: marketEmails.id });
				if (!row) return;
				count++;
				if (content.attachments.length > 0)
					await tx.insert(marketEmailAttachments).values(
						content.attachments.map((a) => ({
							emailId: row.id,
							filename: a.filename,
							contentType: a.contentType,
							size: a.size,
							data: a.data,
						})),
					);
				if (content.html !== undefined)
					await keepHtml(tx, row.id, content.html, content.inline ?? []);
			});
		} catch (error) {
			problems.push(
				`${m.subject || m.messageId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { read: count, problems };
}

// Sorts again what the rules now label differently (a new label, a better
// rule), leaving alone anything staff moved. Returns how many moved.
export async function resort(db: Db) {
	const rows = await db
		.select({
			id: marketEmails.id,
			subject: marketEmails.subject,
			label: marketEmails.label,
		})
		.from(marketEmails)
		.where(isNull(marketEmails.relabelledAt));
	let moved = 0;
	for (const r of rows) {
		const label = labelOf(r.subject);
		if (label === r.label) continue;
		await db
			.update(marketEmails)
			.set({ label })
			.where(and(eq(marketEmails.id, r.id), isNull(marketEmails.relabelledAt)));
		moved++;
	}
	return moved;
}

// Records how reading a mailbox went: a time when it worked, the error
// when it didn't (the last success stays).
export async function recordCheck(
	db: Db,
	mailbox: "purchasing" | "marketplaces",
	error: string | null,
) {
	const now = new Date();
	const set = error
		? { error, erroredAt: now }
		: { checkedAt: now, error: null, erroredAt: null };
	await db
		.insert(mailboxChecks)
		.values({ mailbox, ...set })
		.onConflictDoUpdate({ target: mailboxChecks.mailbox, set });
}

// The newest email kept, so the first sweep reads further back.
export async function newestMarketEmail(db: Db) {
	const [row] = await db
		.select({ at: sql<Date | null>`max(${marketEmails.receivedAt})` })
		.from(marketEmails);
	return row?.at ? new Date(row.at) : null;
}

// A view of the page: the open emails with one label, or those done.
export type MarketView = MarketLabel | "done";

const summary = {
	id: marketEmails.id,
	market: marketEmails.market,
	label: marketEmails.label,
	doneAt: marketEmails.doneAt,
	fromAddress: marketEmails.fromAddress,
	fromName: marketEmails.fromName,
	subject: marketEmails.subject,
	body: marketEmails.body,
	receivedAt: marketEmails.receivedAt,
};

export async function marketMailPage(
	db: Db,
	view: MarketView,
	market: Market | null,
	limit = 150,
) {
	const where = and(
		view === "done"
			? isNotNull(marketEmails.doneAt)
			: and(isNull(marketEmails.doneAt), eq(marketEmails.label, view)),
		market ? eq(marketEmails.market, market) : undefined,
	);
	const [rows, counts, [check]] = await Promise.all([
		db
			.select(summary)
			.from(marketEmails)
			.where(where)
			.orderBy(
				desc(view === "done" ? marketEmails.doneAt : marketEmails.receivedAt),
			)
			.limit(limit),
		db
			.select({
				label: marketEmails.label,
				market: marketEmails.market,
				n: sql<number>`count(*)::int`,
			})
			.from(marketEmails)
			.where(isNull(marketEmails.doneAt))
			.groupBy(marketEmails.label, marketEmails.market),
		db
			.select()
			.from(mailboxChecks)
			.where(eq(mailboxChecks.mailbox, "marketplaces")),
	]);
	const files =
		rows.length === 0
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
								rows.map((r) => r.id),
							),
							isNull(marketEmailAttachments.contentId),
						),
					)
					.orderBy(marketEmailAttachments.id);
	return {
		connected: Boolean(process.env.MARKETPLACE_INBOX?.trim()),
		check: check ?? null,
		// Open emails per label, for the tabs, within the market shown.
		counts: Object.fromEntries(
			MARKET_LABELS.map((l) => [
				l,
				counts
					.filter((c) => c.label === l && (!market || c.market === market))
					.reduce((s, c) => s + c.n, 0),
			]),
		) as Record<MarketLabel, number>,
		emails: rows.map((r) => ({
			...r,
			attachments: files
				.filter((f) => f.emailId === r.id)
				.map(({ emailId: _, ...f }) => f),
		})),
	};
}

export type MarketMailPage = Awaited<ReturnType<typeof marketMailPage>>;

// Done with it, or back to its label.
export async function setDone(db: Db, id: number, done: boolean) {
	const [row] = await db
		.update(marketEmails)
		.set({ doneAt: done ? new Date() : null })
		.where(eq(marketEmails.id, id))
		.returning({ id: marketEmails.id });
	if (!row) throw new Error(`There's no marketplace email ${id}`);
	return row;
}

// Moves it to another label; the sorter won't move it back.
export async function relabel(db: Db, id: number, label: MarketLabel) {
	const [row] = await db
		.update(marketEmails)
		.set({ label, relabelledAt: new Date() })
		.where(eq(marketEmails.id, id))
		.returning({ id: marketEmails.id });
	if (!row) throw new Error(`There's no marketplace email ${id}`);
	return row;
}

// Open emails needing someone, for the sidebar.
export async function countAttention(db: Db) {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(marketEmails)
		.where(
			and(isNull(marketEmails.doneAt), eq(marketEmails.label, "attention")),
		);
	return row?.n ?? 0;
}

export async function marketAttachment(db: Db, id: number) {
	const [file] = await db
		.select()
		.from(marketEmailAttachments)
		.where(eq(marketEmailAttachments.id, id));
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

// Fetches the HTML of emails kept before katasync kept it, newest first, a
// few a run. One gone from the mailbox keeps its text only (empty HTML).
export async function backfillMarketHtml(
	db: Db,
	read: (
		messageId: string,
	) => Promise<{ html: string; inline: InlinePicture[] } | null>,
	limit = 25,
) {
	const rows = await db
		.select({ id: marketEmails.id, messageId: marketEmails.messageId })
		.from(marketEmails)
		.where(isNull(marketEmails.bodyHtml))
		.orderBy(desc(marketEmails.receivedAt))
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

export async function marketEmailHtml(db: Db, id: number) {
	const [row] = await db
		.select({ html: marketEmails.bodyHtml })
		.from(marketEmails)
		.where(eq(marketEmails.id, id));
	return row?.html || null;
}

// Back this far on a sweep; the first, with nothing kept yet, reads a month.
const SWEEP_LOOK_BACK_MS = 3 * 86_400_000;
const FIRST_LOOK_BACK_MS = 30 * 86_400_000;

// Reads the marketplaces mailbox since `since` and keeps what's new. With
// no database handed in (the 5-minute run), asks Microsoft first and wakes
// the database only for new mail; a failure then is left for the sweep,
// which records it. Null when the mailbox isn't set up.
export async function readMarketMail(options: {
	since: Date;
	sweep: boolean;
	db: () => Db;
}) {
	const [graph, { missingEnv }] = await Promise.all([
		import("#/purchasing/inbox/graph"),
		import("#/diagnostics/checks"),
	]);
	const missing = missingEnv([
		"MS_GRAPH_TENANT_ID",
		"MS_GRAPH_CLIENT_ID",
		"MS_GRAPH_CLIENT_SECRET",
		"MARKETPLACE_INBOX",
	]);
	if (missing.length > 0) return { skipped: `set ${missing.join(", ")}` };
	let since = options.since;
	if (options.sweep) {
		const newest = await newestMarketEmail(options.db());
		since = new Date(
			Date.now() - (newest ? SWEEP_LOOK_BACK_MS : FIRST_LOOK_BACK_MS),
		);
	}
	let messages: InboxMessage[];
	try {
		messages = await graph.messagesSince(since, "marketplaces");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.sweep) await recordCheck(options.db(), "marketplaces", message);
		return { error: message };
	}
	if (messages.length === 0 && !options.sweep) return { quiet: true };
	const db = options.db();
	const result = await ingestMarketMail(db, messages, (id) =>
		graph.messageContent(id, "marketplaces"),
	);
	const resorted = options.sweep ? await resort(db) : 0;
	const formatted = options.sweep
		? await backfillMarketHtml(db, (messageId) =>
				readHtml(graph, messageId, "marketplaces"),
			)
		: 0;
	await recordCheck(db, "marketplaces", null);
	return { ...result, resorted, formatted };
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
