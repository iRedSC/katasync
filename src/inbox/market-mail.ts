import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	mailboxChecks,
	marketEmailAttachments,
	marketEmails,
} from "#/db/schema";
import { groupBy } from "#/lib/group-by";
import type { Market } from "#/markets/market";
import type { InboxMessage, InlinePicture } from "#/purchasing/inbox/graph";
import type { ReadContent } from "#/purchasing/inbox/ingest";
import { pointPictures } from "./html";
import { listRules, locked, lockRules, resort } from "./rule-store";
import {
	FOLDERS,
	type Folder,
	flagsOf,
	type Level,
	type Rule,
	sortEmail,
} from "./rules";

// The marketplaces mailbox in katasync: each notice read in from Microsoft
// 365, sorted by marketplace and by the rules into a folder, some marked
// important, and worked through like a mail app (done, moved, marked).
// Server only.

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

// Shopify's new-order email to staff, which it sends as the mailbox itself
// ("[East Coast Drywall Tools] Order #5754 placed by ..."), so it would read
// as one of ours. Every order, TikTok Shop's too, since Shopify relays them.
export function isShopifyOrderNotice(m: {
	fromAddress: string;
	subject: string;
}) {
	const inbox = process.env.MARKETPLACE_INBOX?.trim().toLowerCase();
	return (
		Boolean(inbox) &&
		m.fromAddress.trim().toLowerCase() === inbox &&
		/^\[[^\]]+\] Order #\d+ placed by /i.test(m.subject)
	);
}

// The marketplace an email is from: its sender's, or Shopify for its order
// notices.
export function marketOfEmail(m: { fromAddress: string; subject: string }) {
	return (
		marketOf(m.fromAddress) ?? (isShopifyOrderNotice(m) ? "shopify" : null)
	);
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
			const market = marketOfEmail(m);
			const inserted = await db.transaction(async (tx) => {
				// Sorted under the lock, so a rule saved meanwhile isn't missed.
				await lockRules(tx);
				const sorted = sortEmail(await listRules(tx), {
					...m,
					body: content.body,
					market,
				});
				const [row] = await tx
					.insert(marketEmails)
					.values({
						messageId: m.messageId,
						market,
						folder: sorted.folder,
						...flagsOf(sorted.level),
						readAt: sorted.read ? new Date() : null,
						doneAt: sorted.done ? new Date() : null,
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
				if (!row) return false;
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
				return true;
			});
			// Counted once the transaction has committed, not while it runs.
			if (inserted) count++;
		} catch (error) {
			problems.push(
				`${m.subject || m.messageId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { read: count, problems };
}

// How a read of the mailbox went. Partial and failed name the first email
// that didn't read, and stand until a sweep reads clean: only a sweep looks
// back far enough to read those emails again.
export type ReadOutcome =
	| { state: "complete" }
	| { state: "partial" | "failed"; error: string };

// Records how reading a mailbox went: a time when it worked, the error when
// it didn't. A clean run that isn't a sweep leaves an error standing, since it
// never looked at the emails that failed.
export async function recordCheck(
	db: Db,
	mailbox: "purchasing" | "marketplaces",
	outcome: ReadOutcome,
	sweep: boolean,
) {
	const now = new Date();
	const set =
		outcome.state !== "complete"
			? { error: outcome.error, erroredAt: now }
			: sweep
				? { checkedAt: now, sweptAt: now, error: null, erroredAt: null }
				: { checkedAt: now };
	await db
		.insert(mailboxChecks)
		.values({ mailbox, ...set })
		.onConflictDoUpdate({ target: mailboxChecks.mailbox, set });
}

// Complete when nothing failed; partial when some mail read anyway, else
// failed. The error names the first email that didn't read, and how many.
function outcomeOf(result: { read: number; problems: string[] }): ReadOutcome {
	const [first, ...rest] = result.problems;
	if (first === undefined) return { state: "complete" };
	const error =
		rest.length === 0
			? `Couldn't read ${first}`
			: `Couldn't read ${result.problems.length} emails, e.g. ${first}`;
	return { state: result.read > 0 ? "partial" : "failed", error };
}

// The newest email kept, so the first sweep reads further back.
export async function newestMarketEmail(db: Db) {
	const [row] = await db
		.select({ at: sql<Date | null>`max(${marketEmails.receivedAt})` })
		.from(marketEmails);
	return row?.at ? new Date(row.at) : null;
}

// A view of the page: the open emails that are important, or in one folder,
// or those done.
export type MarketView = "important" | Folder | "done";
export const MARKET_VIEWS = ["important", ...FOLDERS, "done"] as const;

const summary = {
	id: marketEmails.id,
	market: marketEmails.market,
	folder: marketEmails.folder,
	important: marketEmails.important,
	critical: marketEmails.critical,
	relabelledAt: marketEmails.relabelledAt,
	importanceSetAt: marketEmails.importanceSetAt,
	doneAt: marketEmails.doneAt,
	readAt: marketEmails.readAt,
	fromAddress: marketEmails.fromAddress,
	fromName: marketEmails.fromName,
	subject: marketEmails.subject,
	body: marketEmails.body,
	receivedAt: marketEmails.receivedAt,
};

// Why an email sits where it does: moved or marked by hand, or the rule that
// put it there (null: no rule moved it, so Updates).
export type Why = {
	folder: "by-hand" | { rule: number; name: string } | null;
	important: "by-hand" | { rule: number; name: string }[];
};

function why(
	rules: Rule[],
	e: Parameters<typeof sortEmail>[1] & {
		relabelledAt: Date | null;
		importanceSetAt: Date | null;
	},
): Why {
	const s = sortEmail(rules, e);
	const named = (id: number) => ({
		rule: id,
		name: rules.find((r) => r.id === id)?.name ?? "",
	});
	return {
		folder:
			e.relabelledAt !== null
				? "by-hand"
				: s.folderRule === null
					? null
					: named(s.folderRule),
		important:
			e.importanceSetAt !== null ? "by-hand" : s.importantRules.map(named),
	};
}

// Where the next page of a view starts: the sort time and id of the page's last
// email. The id tells apart emails at the same moment, so none is skipped.
export type MarketCursor = { at: number; id: number };

export async function marketMailPage(
	db: Db,
	view: MarketView,
	market: Market | null,
	{ limit = 150, after }: { limit?: number; after?: MarketCursor } = {},
) {
	const sortAt =
		view === "done" ? marketEmails.doneAt : marketEmails.receivedAt;
	const where = and(
		view === "done"
			? isNotNull(marketEmails.doneAt)
			: and(
					isNull(marketEmails.doneAt),
					view === "important"
						? eq(marketEmails.important, true)
						: eq(marketEmails.folder, view),
				),
		market ? eq(marketEmails.market, market) : undefined,
		after
			? or(
					lt(sortAt, new Date(after.at)),
					and(eq(sortAt, new Date(after.at)), lt(marketEmails.id, after.id)),
				)
			: undefined,
	);
	const [fetched, counts, [check], rules] = await Promise.all([
		db
			.select(summary)
			.from(marketEmails)
			.where(where)
			.orderBy(desc(sortAt), desc(marketEmails.id))
			.limit(limit + 1),
		db
			.select({
				folder: marketEmails.folder,
				market: marketEmails.market,
				n: sql<number>`count(*)::int`,
				important: sql<number>`(count(*) filter (where ${marketEmails.important}))::int`,
				critical: sql<number>`(count(*) filter (where ${marketEmails.critical}))::int`,
			})
			.from(marketEmails)
			.where(and(isNull(marketEmails.doneAt), isNull(marketEmails.readAt)))
			.groupBy(marketEmails.folder, marketEmails.market),
		db
			.select()
			.from(mailboxChecks)
			.where(eq(mailboxChecks.mailbox, "marketplaces")),
		listRules(db),
	]);
	// One more than a page, to know whether there's a next one.
	const more = fetched.length > limit;
	const rows = more ? fetched.slice(0, limit) : fetched;
	const last = rows.at(-1);
	const lastAt = view === "done" ? last?.doneAt : last?.receivedAt;
	const next =
		more && last && lastAt ? { at: lastAt.getTime(), id: last.id } : null;
	const shown = counts.filter((c) => !market || c.market === market);
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
	const byEmail = groupBy(files, (f) => f.emailId);
	return {
		connected: Boolean(process.env.MARKETPLACE_INBOX?.trim()),
		check: check ?? null,
		// Where the page after this one starts; null when this is all of them.
		next,
		// Unread open emails per folder, and important (critical among them),
		// within the market shown.
		counts: {
			important: shown.reduce((s, c) => s + c.important, 0),
			critical: shown.reduce((s, c) => s + c.critical, 0),
			...(Object.fromEntries(
				FOLDERS.map((f) => [
					f,
					shown.filter((c) => c.folder === f).reduce((s, c) => s + c.n, 0),
				]),
			) as Record<Folder, number>),
		},
		emails: rows.map(({ relabelledAt, importanceSetAt, ...r }) => ({
			...r,
			why: why(rules, { ...r, relabelledAt, importanceSetAt }),
			attachments: (byEmail.get(r.id) ?? []).map(({ emailId: _, ...f }) => f),
		})),
	};
}

export type MarketMailPage = Awaited<ReturnType<typeof marketMailPage>>;

// Done with it, or back to its folder.
export async function setDone(db: Db, id: number, done: boolean) {
	const [row] = await db
		.update(marketEmails)
		.set({ doneAt: done ? new Date() : null })
		.where(eq(marketEmails.id, id))
		.returning({ id: marketEmails.id });
	if (!row) throw new Error(`There's no marketplace email ${id}`);
	return row;
}

// Read it, or back to unread.
export async function setRead(db: Db, id: number, read: boolean) {
	const [row] = await db
		.update(marketEmails)
		.set({ readAt: read ? new Date() : null })
		.where(eq(marketEmails.id, id))
		.returning({ id: marketEmails.id });
	if (!row) throw new Error(`There's no marketplace email ${id}`);
	return row;
}

// Moves it to another folder, where the rules won't move it from; null hands
// its folder back to the rules.
export async function moveTo(db: Db, id: number, folder: Folder | null) {
	return locked(db, async (tx) => {
		const [row] = await tx
			.update(marketEmails)
			.set(
				folder ? { folder, relabelledAt: new Date() } : { relabelledAt: null },
			)
			.where(eq(marketEmails.id, id))
			.returning({ id: marketEmails.id });
		if (!row) throw new Error(`There's no marketplace email ${id}`);
		if (!folder) await resort(tx, [id]);
		return row;
	});
}

// Marks it important, critical, or neither, which the rules won't change
// back; null hands that back to the rules.
export async function setImportant(db: Db, id: number, level: Level | null) {
	return locked(db, async (tx) => {
		const [row] = await tx
			.update(marketEmails)
			.set(
				level === null
					? { importanceSetAt: null }
					: { ...flagsOf(level), importanceSetAt: new Date() },
			)
			.where(eq(marketEmails.id, id))
			.returning({ id: marketEmails.id });
		if (!row) throw new Error(`There's no marketplace email ${id}`);
		if (level === null) await resort(tx, [id]);
		return row;
	});
}

// Unread open important emails, and how many of them are critical, for the
// sidebar.
export async function countImportant(db: Db) {
	const [row] = await db
		.select({
			important: sql<number>`count(*)::int`,
			critical: sql<number>`(count(*) filter (where ${marketEmails.critical}))::int`,
		})
		.from(marketEmails)
		.where(
			and(
				isNull(marketEmails.doneAt),
				isNull(marketEmails.readAt),
				eq(marketEmails.important, true),
			),
		);
	return { important: row?.important ?? 0, critical: row?.critical ?? 0 };
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

// Back this far on a sweep at least, and from a day before the last sweep
// that read everything, so an outage or an email that kept failing is read
// once the sweep can; never more than a month, which the first reads too.
const SWEEP_LOOK_BACK_MS = 3 * 86_400_000;
const FIRST_LOOK_BACK_MS = 30 * 86_400_000;
const OVERLAP_MS = 86_400_000;

// Where a sweep starts reading.
export function sweepSince(
	now: number,
	newest: Date | null,
	sweptAt: Date | null,
) {
	if (!newest) return new Date(now - FIRST_LOOK_BACK_MS);
	const from = sweptAt
		? Math.min(now - SWEEP_LOOK_BACK_MS, sweptAt.getTime() - OVERLAP_MS)
		: now - SWEEP_LOOK_BACK_MS;
	return new Date(Math.max(from, now - FIRST_LOOK_BACK_MS));
}

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
		const db = options.db();
		const [newest, [check]] = await Promise.all([
			newestMarketEmail(db),
			db
				.select({ sweptAt: mailboxChecks.sweptAt })
				.from(mailboxChecks)
				.where(eq(mailboxChecks.mailbox, "marketplaces")),
		]);
		since = sweepSince(Date.now(), newest, check?.sweptAt ?? null);
	}
	let messages: InboxMessage[];
	try {
		messages = await graph.messagesSince(
			since,
			"marketplaces",
			isShopifyOrderNotice,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.sweep)
			await recordCheck(
				options.db(),
				"marketplaces",
				{ state: "failed", error: message },
				options.sweep,
			);
		return { error: message };
	}
	if (messages.length === 0 && !options.sweep) return { quiet: true };
	const db = options.db();
	const result = await ingestMarketMail(db, messages, (id) =>
		graph.messageContent(id, "marketplaces"),
	);
	// Buyers' messages among them go to their threads now; the messages cron
	// does it too, and says when it can't.
	const threaded = await import("#/buyers/amazon-mail")
		.then((m) => m.threadAmazonMail(db))
		.catch(() => null);
	const shopify = await import("#/buyers/shopify-mail")
		.then((m) => m.threadShopifyMail(db))
		.catch(() => null);
	const resorted = options.sweep ? await resort(db) : null;
	const formatted = options.sweep
		? await backfillMarketHtml(db, (messageId) =>
				readHtml(graph, messageId, "marketplaces"),
			)
		: 0;
	// Reading the list but none of the emails isn't working: say so. A run that
	// read some and missed others says so too, with the error, so the caller
	// can show it.
	const outcome = outcomeOf(result);
	await recordCheck(db, "marketplaces", outcome, options.sweep);
	return {
		...result,
		threaded,
		shopify,
		resorted,
		formatted,
		...(outcome.state === "complete" ? {} : { error: outcome.error }),
	};
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
