import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { countWaiting } from "#/buyers/threads";
import { getDb } from "#/db/client";
import { marketEmails } from "#/db/schema";
import {
	marketEmailHtml,
	marketMailPage,
	moveTo,
	readMarketMail,
	setDone,
	setImportant,
	setRead,
} from "#/inbox/market-mail";
import {
	createRule,
	deleteRule,
	listRules,
	previewRule,
	reorderRules,
	restoreRule,
	updateRule,
} from "#/inbox/rule-store";
import { FOLDERS, ruleSchema } from "#/inbox/rules";
import { countUnfiled, emailHtml } from "#/purchasing/inbox/ingest";

// The Inbox page's server side: the marketplaces mailbox and the rules that
// sort it. Only server functions here: a plain export would keep these
// imports in the browser bundle.

const market = "'shopify' | 'amazon' | 'ebay' | 'tiktok'";
const folder = "'orders' | 'returns' | 'violations' | 'updates'";

// The page after `after`, where the last one stopped, so none is skipped or repeated.
export const listMarketMail = createServerFn({ method: "GET" })
	.validator(
		type({
			view: `${folder} | 'important' | 'done'`,
			market: `${market} | null`,
			"after?": { at: "number.integer", id: "number.integer > 0" },
		}),
	)
	.handler(async ({ data }) =>
		marketMailPage(getDb(), data.view, data.market, { after: data.after }),
	);

export const setMarketEmailDone = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", done: "boolean" }))
	.handler(async ({ data }) => setDone(getDb(), data.id, data.done));

// Null hands the folder, or importance, back to the rules.
export const setMarketEmailRead = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", read: "boolean" }))
	.handler(async ({ data }) => setRead(getDb(), data.id, data.read));

export const moveMarketEmail = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", folder: `${folder} | null` }))
	.handler(async ({ data }) => moveTo(getDb(), data.id, data.folder));

export const markMarketEmailImportant = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			level: "'normal' | 'important' | 'critical' | null",
		}),
	)
	.handler(async ({ data }) => setImportant(getDb(), data.id, data.level));

// Reads the mailbox now, as the sweep does, so staff needn't wait for it.
export const checkMarketMailNow = createServerFn({ method: "POST" }).handler(
	async () => readMarketMail({ since: new Date(), sweep: true, db: getDb }),
);

// What waits in every folder, for the side list: buyers waiting on a reply,
// unread open marketplace emails per folder and important, critical among
// them (within one market, when filtered), and supplier emails to file and
// set aside, unread.
export const inboxCounts = createServerFn({ method: "GET" })
	.validator(type({ market: `${market} | null` }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [rows, unfiled, buyers] = await Promise.all([
			db
				.select({
					folder: marketEmails.folder,
					n: sql<number>`count(*)::int`,
					important: sql<number>`(count(*) filter (where ${marketEmails.important}))::int`,
					critical: sql<number>`(count(*) filter (where ${marketEmails.critical}))::int`,
				})
				.from(marketEmails)
				.where(
					and(
						isNull(marketEmails.doneAt),
						isNull(marketEmails.readAt),
						data.market ? eq(marketEmails.market, data.market) : undefined,
					),
				)
				.groupBy(marketEmails.folder),
			countUnfiled(db),
			countWaiting(db, data.market),
		]);
		return {
			important: rows.reduce((s, r) => s + r.important, 0),
			critical: rows.reduce((s, r) => s + r.critical, 0),
			...(Object.fromEntries(
				FOLDERS.map((f) => [f, rows.find((r) => r.folder === f)?.n ?? 0]),
			) as Record<(typeof FOLDERS)[number], number>),
			buyers,
			toFile: unfiled.toFileUnread,
			setAside: unfiled.setAsideUnread,
		};
	});

export type InboxCounts = Awaited<ReturnType<typeof inboxCounts>>;

export const getMailRules = createServerFn({ method: "GET" }).handler(
	async () => listRules(getDb()),
);

// What a rule being written would match, as it's written.
export const previewMailRule = createServerFn({ method: "POST" })
	.validator(ruleSchema)
	.handler(async ({ data }) => previewRule(getDb(), data));

export const saveMailRule = createServerFn({ method: "POST" })
	.validator(
		z.object({ id: z.number().int().positive().nullable(), rule: ruleSchema }),
	)
	.handler(async ({ data }) =>
		data.id === null
			? createRule(getDb(), data.rule, "staff")
			: updateRule(getDb(), data.id, data.rule, "staff"),
	);

export const deleteMailRule = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => deleteRule(getDb(), data.id));

export const restoreMailRule = createServerFn({ method: "POST" })
	.validator(
		z.object({
			rule: ruleSchema,
			before: z.number().int().positive().nullable(),
			by: z.enum(["staff", "claude"]),
		}),
	)
	.handler(async ({ data }) =>
		restoreRule(getDb(), { ...data.rule, before: data.before, by: data.by }),
	);

export const reorderMailRules = createServerFn({ method: "POST" })
	.validator(z.object({ ids: z.array(z.number().int().positive()) }))
	.handler(async ({ data }) => reorderRules(getDb(), data.ids));

// An email as sent, fetched when it's opened rather than with the list.
// Null when katasync has only its text.
export const getEmailHtml = createServerFn({ method: "GET" })
	.validator(
		type({ box: "'purchasing' | 'marketplaces'", id: "number.integer > 0" }),
	)
	.handler(async ({ data }) =>
		data.box === "purchasing"
			? emailHtml(getDb(), data.id)
			: marketEmailHtml(getDb(), data.id),
	);
