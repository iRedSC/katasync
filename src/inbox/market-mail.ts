import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { isRelayed } from "#/buyers/amazon-mail";
import type { Db } from "#/db/client";
import {
	mailboxChecks,
	marketEmailAttachments,
	marketEmails,
} from "#/db/schema";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import type { ReadContent } from "#/purchasing/inbox/ingest";
import { backfillMarketHtml, keepHtml, readHtml } from "./market-mail/content";
import { checksSender, recheckSenders } from "./market-mail/senders";
import { listRules, locked, lockRules, resort } from "./rule-store";
import { type Folder, flagsOf, type Level, sortEmail } from "./rules";
import { type Header, senderAuthenticated } from "./sender-auth";
import { marketOf } from "./sender-domains";
import { isVoicemail } from "./voicemail-model";

export {
	backfillMarketHtml,
	marketAttachment,
	marketEmailHtml,
	readHtml,
} from "./market-mail/content";
export * from "./market-mail/page";
export { marketOf } from "./sender-domains";

// The marketplaces mailbox in katasync: each notice read in from Microsoft
// 365, sorted by marketplace and by the rules into a folder, some marked
// important, and worked through like a mail app (done, moved, marked).
// Server only. The Inbox's page of it is ./market-mail/page.ts.

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
// Mail whose sender is asked about (./market-mail/senders.ts) has its
// headers read too, for whether its sender is who it says: those become
// buyer threads. There's no reading without them, so it can't be skipped.
export async function ingestMarketMail(
	db: Db,
	messages: InboxMessage[],
	read: ReadContent,
	readHeaders: (graphId: string) => Promise<Header[]>,
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
			const voicemail = isVoicemail({ ...m, body: content.body });
			const market = marketOfEmail(m);
			const checked = checksSender(market);
			const authenticated =
				checked &&
				senderAuthenticated(await readHeaders(m.graphId), m.fromAddress);
			// The rules close Amazon's relayed buyer messages on arrival, since
			// they're answered in Buyers. One that can't be filed there stays
			// open and unread here instead, so it isn't missed.
			const heldBack =
				market === "amazon" && !authenticated && isRelayed(m.fromAddress);
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
						senderAuthenticated: authenticated,
						senderCheckedAt: checked ? new Date() : null,
						readAt: sorted.read && !heldBack ? new Date() : null,
						doneAt: sorted.done && !heldBack ? new Date() : null,
						fromAddress: m.fromAddress,
						fromName: m.fromName,
						recipients: m.recipients,
						subject: m.subject,
						body: content.body,
						receivedAt: m.receivedAt,
						...(voicemail
							? {
									voicemail: { state: "pending" as const },
									folder: "updates" as const,
									relabelledAt: new Date(),
									doneAt: null,
									readAt: null,
									important: false,
									critical: false,
								}
							: {}),
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

// Done with it, or back to its folder.
export async function setDone(db: Db, id: number, done: boolean) {
	const [row] = await db
		.update(marketEmails)
		.set({
			doneAt: done ? new Date() : null,
			...(!done
				? {
						voicemail: sql`case when ${marketEmails.voicemail}->>'state' = 'dismissed' then jsonb_build_object('state', 'review', 'reason', left('Restored: ' || (${marketEmails.voicemail}->>'reason'), 500)) else ${marketEmails.voicemail} end`,
					}
				: {}),
		})
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
			.where(and(eq(marketEmails.id, id), isNull(marketEmails.voicemail)))
			.returning({ id: marketEmails.id });
		if (!row)
			throw new Error(
				`Email ${id} cannot be moved. Voicemails stay in Voicemails; use Done or priority instead.`,
			);
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
			(message) =>
				isShopifyOrderNotice(message) ||
				/^(?:fw|fwd):.*\bnew voicemail\b/i.test(message.subject),
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
	const result = await ingestMarketMail(
		db,
		messages,
		(id) => graph.messageContent(id, "marketplaces"),
		(id) => graph.messageHeaders(id, "marketplaces"),
	);
	// Kept without their sender asked: asked now, before threading.
	const rechecked = options.sweep
		? await recheckSenders(db, async (messageId) => {
				const id = await graph.findMessage(messageId, "marketplaces");
				if (!id) return null;
				// A kept Graph id can outlive its email: gone, not a failure.
				return graph
					.messageHeaders(id, "marketplaces")
					.catch((error: Error) => {
						if (/answered 404/.test(error.message)) return null;
						throw error;
					});
			})
		: null;
	// Buyers' messages among them go to their threads now; the messages cron
	// does it too, and says when it can't.
	const threaded = await import("#/buyers/amazon-mail")
		.then((m) => m.threadAmazonMail(db))
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
		rechecked,
		resorted,
		formatted,
		...(outcome.state === "complete" ? {} : { error: outcome.error }),
	};
}
