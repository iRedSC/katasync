import { asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { mailRules, marketEmails } from "#/db/schema";
import {
	type Folder,
	matches,
	type Rule,
	type RuleInput,
	ruleSchema,
	sortEmail,
} from "./rules";

// The sorting rules kept in mail_rules, and the mail they sort. Every change
// to the rules sorts the mailbox again at once, so what the page shows is
// always what the rules say. Server only.

export class RuleError extends Error {}

export async function listRules(db: Db): Promise<Rule[]> {
	const rows = await db
		.select()
		.from(mailRules)
		.orderBy(asc(mailRules.position), asc(mailRules.id));
	return rows.map((r) => ({
		id: r.id,
		position: r.position,
		name: r.name,
		conditions: r.conditions,
		folder: r.folder,
		important: r.important,
		markRead: r.markRead,
		by: r.by,
	}));
}

// What sorting changed: emails moved to another folder, and emails whose
// importance changed.
export type Resorted = { moved: number; marked: number };

// Holds the rules still until the transaction ends: every change to them,
// every sort, and every email sorted as it arrives takes it first, so a sort
// read under old rules can't land after a change and undo it.
export async function lockRules(tx: Db) {
	await tx.execute(sql`select pg_advisory_xact_lock(${RULES_LOCK})`);
}
// Any constant key; this one spells "mail".
const RULES_LOCK = 0x6d61696c;

// Runs fn in a transaction holding the rules lock. It's taken before any email
// row is locked, as every sort takes it; the reverse order can deadlock.
export const locked = <T>(db: Db, fn: (tx: Db) => Promise<T>) =>
	db.transaction(async (tx) => {
		await lockRules(tx);
		return fn(tx);
	});

// Sorts every email (or these) again by the rules, leaving what someone moved
// or marked by hand.
export async function resort(db: Db, only?: number[]): Promise<Resorted> {
	return locked(db, (tx) => sortAgain(tx, only));
}

async function sortAgain(db: Db, only?: number[]): Promise<Resorted> {
	const [rules, rows] = await Promise.all([
		listRules(db),
		db
			.select({
				id: marketEmails.id,
				subject: marketEmails.subject,
				fromAddress: marketEmails.fromAddress,
				fromName: marketEmails.fromName,
				body: marketEmails.body,
				market: marketEmails.market,
				folder: marketEmails.folder,
				important: marketEmails.important,
				relabelledAt: marketEmails.relabelledAt,
				importanceSetAt: marketEmails.importanceSetAt,
			})
			.from(marketEmails)
			.where(only ? inArray(marketEmails.id, only) : undefined),
	]);
	const toFolder = new Map<Folder, number[]>();
	const toImportant = new Map<boolean, number[]>();
	for (const r of rows) {
		const s = sortEmail(rules, r);
		if (r.relabelledAt === null && s.folder !== r.folder)
			toFolder.set(s.folder, [...(toFolder.get(s.folder) ?? []), r.id]);
		if (r.importanceSetAt === null && s.important !== r.important)
			toImportant.set(s.important, [
				...(toImportant.get(s.important) ?? []),
				r.id,
			]);
	}
	// Re-checked in the update, so one moved by hand meanwhile stays.
	for (const [folder, ids] of toFolder)
		await db
			.update(marketEmails)
			.set({ folder })
			.where(
				sql`${inArray(marketEmails.id, ids)} and ${isNull(marketEmails.relabelledAt)}`,
			);
	for (const [important, ids] of toImportant)
		await db
			.update(marketEmails)
			.set({ important })
			.where(
				sql`${inArray(marketEmails.id, ids)} and ${isNull(marketEmails.importanceSetAt)}`,
			);
	return {
		moved: [...toFolder.values()].reduce((n, ids) => n + ids.length, 0),
		marked: [...toImportant.values()].reduce((n, ids) => n + ids.length, 0),
	};
}

function parse(input: unknown): RuleInput {
	const r = ruleSchema.safeParse(input);
	if (!r.success)
		throw new RuleError(r.error.issues.map((i) => i.message).join("; "));
	return r.data;
}

// Adds a rule, last unless placed before another, and sorts by it.
export async function createRule(
	db: Db,
	input: unknown,
	by: Rule["by"],
	before?: number,
) {
	const rule = parse(input);
	return locked(db, async (tx) => {
		const position = await slot(tx, before);
		const [row] = await tx
			.insert(mailRules)
			.values({ ...rule, position, by })
			.returning({ id: mailRules.id });
		return { id: row.id, ...(await sortAgain(tx)) };
	});
}

export async function updateRule(
	db: Db,
	id: number,
	input: unknown,
	by: Rule["by"],
) {
	const rule = parse(input);
	return locked(db, async (tx) => {
		const [row] = await tx
			.update(mailRules)
			.set({ ...rule, by, updatedAt: new Date() })
			.where(eq(mailRules.id, id))
			.returning({ id: mailRules.id });
		if (!row) throw new RuleError(`There's no rule ${id}`);
		return { id, ...(await sortAgain(tx)) };
	});
}

// Removes a rule. Returns it and the rule it ran before (null: it was
// last), so it can be put back where it was.
export async function deleteRule(db: Db, id: number) {
	return locked(db, async (tx) => {
		const rules = await listRules(tx);
		const at = rules.findIndex((r) => r.id === id);
		if (at < 0) throw new RuleError(`There's no rule ${id}`);
		const [row] = await tx
			.delete(mailRules)
			.where(eq(mailRules.id, id))
			.returning();
		return {
			rule: row,
			before: rules[at + 1]?.id ?? null,
			...(await sortAgain(tx)),
		};
	});
}

// Puts a deleted rule back before the rule it ran before, or last when that
// one's gone too.
export async function restoreRule(
	db: Db,
	rule: RuleInput & { before: number | null; by: Rule["by"] },
) {
	const parsed = parse(rule);
	return locked(db, async (tx) => {
		const still = (await listRules(tx)).some((r) => r.id === rule.before);
		const position = await slot(
			tx,
			still ? (rule.before ?? undefined) : undefined,
		);
		const [row] = await tx
			.insert(mailRules)
			.values({ ...parsed, position, by: rule.by })
			.returning({ id: mailRules.id });
		return { id: row.id, ...(await sortAgain(tx)) };
	});
}

// Puts the rules in this order. Every rule must be named once, so a stale
// list can't drop one to the end unseen.
export async function reorderRules(db: Db, ids: number[]) {
	return locked(db, async (tx) => {
		const have = await tx.select({ id: mailRules.id }).from(mailRules);
		const known = new Set(have.map((r) => r.id));
		if (
			ids.length !== known.size ||
			new Set(ids).size !== ids.length ||
			ids.some((id) => !known.has(id))
		)
			throw new RuleError("The rules changed; reload and try again");
		for (const [i, id] of ids.entries())
			await tx
				.update(mailRules)
				.set({ position: (i + 1) * 10 })
				.where(eq(mailRules.id, id));
		return sortAgain(tx);
	});
}

// A position before `before`, or after the last rule; makes room when two
// rules sit next to each other.
async function slot(db: Db, before: number | undefined) {
	const rules = await listRules(db);
	if (before === undefined) return (rules.at(-1)?.position ?? 0) + 10;
	const at = rules.findIndex((r) => r.id === before);
	if (at < 0) throw new RuleError(`There's no rule ${before}`);
	for (const [i, r] of rules.entries())
		await db
			.update(mailRules)
			.set({ position: (i + (i >= at ? 2 : 1)) * 10 })
			.where(eq(mailRules.id, r.id));
	return (at + 1) * 10;
}

// What a rule would match if saved: how many emails, and the newest few,
// each with where it sits now.
export async function previewRule(db: Db, input: unknown, limit = 8) {
	const rule = parse(input);
	const rows = await db
		.select({
			id: marketEmails.id,
			subject: marketEmails.subject,
			fromAddress: marketEmails.fromAddress,
			fromName: marketEmails.fromName,
			body: marketEmails.body,
			market: marketEmails.market,
			folder: marketEmails.folder,
			important: marketEmails.important,
			done: sql<boolean>`${marketEmails.doneAt} is not null`,
			read: sql<boolean>`${marketEmails.readAt} is not null`,
			pinned: sql<boolean>`${marketEmails.relabelledAt} is not null`,
			receivedAt: marketEmails.receivedAt,
		})
		.from(marketEmails)
		.orderBy(sql`${marketEmails.receivedAt} desc`);
	const hits = rows.filter((r) => matches(rule, r));
	return {
		count: hits.length,
		emails: hits
			.slice(0, limit)
			.map(({ body: _, fromAddress, fromName, ...r }) => ({
				...r,
				from: fromName ?? fromAddress,
			})),
	};
}

export type RulePreview = Awaited<ReturnType<typeof previewRule>>;
