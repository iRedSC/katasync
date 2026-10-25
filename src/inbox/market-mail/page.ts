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
import { listRules } from "../rule-store";
import { FOLDERS, type Folder, type Rule, sortEmail } from "../rules";

// One page of the marketplaces mailbox as the Inbox shows it, with why each
// email sits where it does. Server only.

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
