import { z } from "zod";
import { MARKETS, type Market } from "#/markets/market";

// The rules that sort the marketplaces mailbox. Each rule is a few conditions,
// all or any of which must hold, and what to do when they do: move the email
// to a folder, mark it important or critical, have it arrive read, or any of
// those. Rules run in order; the first that moves an email decides its
// folder, and any that marks it makes it important (critical, when one says
// so). An
// email no rule moves goes to Updates. The defaults are rules like any other
// (seeded by drizzle/0098), so staff and Claude change them the same way.
// Pure, so the editor can show what a rule says as it's written.

export const FOLDERS = ["orders", "returns", "violations", "updates"] as const;
export type Folder = (typeof FOLDERS)[number];
export const FALLBACK_FOLDER: Folder = "updates";

export const FOLDER_NAMES: Record<Folder, string> = {
	orders: "Orders",
	returns: "Returns",
	violations: "Violations",
	updates: "Updates",
};

// What a condition reads. Sender is the address and the name.
export const TEXT_FIELDS = ["subject", "sender", "body"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];
// "other" is an email from no marketplace.
export const MARKET_CHOICES = [...MARKETS, "other"] as const;
export type MarketChoice = Market | "other";

// A word or phrase, with at most one * and only at its end. A * anywhere
// else could make the pattern backtrack for seconds on one email.
const term = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.refine((s) => !s.slice(0, -1).includes("*"), {
		message: "A * can only end a word, like violat*",
	})
	.transform((s) => s.toLowerCase());

export const conditionSchema = z.discriminatedUnion("field", [
	z.object({
		field: z.enum(TEXT_FIELDS),
		// Any of these words or phrases; a trailing * matches any ending
		// (violat* is violation, violated...).
		has: z.array(term).min(1).max(60),
		not: z.boolean().default(false),
	}),
	z.object({
		field: z.literal("market"),
		is: z.array(z.enum(MARKET_CHOICES)).min(1),
		not: z.boolean().default(false),
	}),
]);
export type Condition = z.infer<typeof conditionSchema>;

// How much an email needs someone. Critical is important too: it shows in
// Important, in red. Kept as two flags (important, critical) in the
// database, which refuses critical without important; written only through
// flagsOf, so the two can't disagree.
export const LEVELS = ["normal", "important", "critical"] as const;
export type Level = (typeof LEVELS)[number];
export const levelOf = (e: { important: boolean; critical: boolean }): Level =>
	e.critical ? "critical" : e.important ? "important" : "normal";
export const flagsOf = (l: Level) => ({
	important: l !== "normal",
	critical: l === "critical",
});

// Whether every condition must hold, or any one.
export const MATCHES = ["all", "any"] as const;
export type Match = (typeof MATCHES)[number];

// A rule as written; one that does nothing, or matches everything, can't be.
// Critical marks important too, so one saying critical alone is both.
export const ruleSchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		match: z.enum(MATCHES).default("all"),
		conditions: z.array(conditionSchema).min(1).max(10),
		folder: z.enum(FOLDERS).nullable(),
		important: z.boolean(),
		critical: z.boolean().default(false),
		// Matching emails arrive read; never applied to mail already in.
		markRead: z.boolean().default(false),
		// Matching emails arrive done, and read; as markRead, only arriving.
		markDone: z.boolean().default(false),
	})
	.refine(
		(r) =>
			r.folder !== null ||
			r.important ||
			r.critical ||
			r.markRead ||
			r.markDone,
		{
			message: "A rule has to move the email, mark it important, read, or done",
		},
	)
	.transform((r) => ({ ...r, important: r.important || r.critical }));
export type RuleInput = z.output<typeof ruleSchema>;
export type Rule = RuleInput & {
	id: number;
	position: number;
	by: "staff" | "claude";
};

// What a rule reads of an email.
export type Sortable = {
	subject: string;
	fromAddress: string;
	fromName: string | null;
	body: string;
	market: Market | null;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A term as a pattern: whole words, so "case" isn't "showcase", except where
// the term itself starts or ends on a symbol ("@amazon.com"). Only a final *
// is a wildcard; any other, as a rule saved before the schema refused them
// might have, is a plain character, so no pattern can backtrack.
function pattern(t: string) {
	const stem = t.endsWith("*");
	const body = escapeRegex(stem ? t.slice(0, -1) : t).replace(/\s+/g, "\\s+");
	const start = /^\w/.test(t) ? "(?<![\\w])" : "";
	const end = stem ? "\\w*" : /\w$/.test(t) ? "(?![\\w])" : "";
	return `${start}${body}${end}`;
}

const compiled = new Map<string, RegExp>();
function termsRegex(terms: string[]) {
	const key = terms.join("\u0000");
	let re = compiled.get(key);
	if (!re) {
		re = new RegExp(terms.map(pattern).join("|"), "i");
		compiled.set(key, re);
	}
	return re;
}

function text(email: Sortable, field: TextField) {
	if (field === "subject") return email.subject;
	if (field === "body") return email.body;
	return `${email.fromName ?? ""} ${email.fromAddress}`;
}

export function holds(c: Condition, email: Sortable) {
	const hit =
		c.field === "market"
			? c.is.includes(email.market ?? "other")
			: termsRegex(c.has).test(text(email, c.field));
	return hit !== c.not;
}

export const matches = (
	rule: Pick<Rule, "conditions" | "match">,
	email: Sortable,
) =>
	rule.match === "any"
		? rule.conditions.some((c) => holds(c, email))
		: rule.conditions.every((c) => holds(c, email));

// Where the rules put an email, and which rules decided: the folder's rule
// (null when none moved it) and each that marked it important or critical.
// read and done are for an email arriving; the rules never change them
// after. Read never when important; done always wins, read too, since a
// rule saying done says there's nothing to do.
export type Sorting = {
	folder: Folder;
	level: Level;
	read: boolean;
	done: boolean;
	folderRule: number | null;
	importantRules: number[];
};

export function sortEmail(rules: readonly Rule[], email: Sortable): Sorting {
	let folder: Folder | null = null;
	let folderRule: number | null = null;
	const importantRules: number[] = [];
	let critical = false;
	let read = false;
	let done = false;
	for (const r of [...rules].sort((a, b) => a.position - b.position)) {
		if (!matches(r, email)) continue;
		if (r.folder && folder === null) {
			folder = r.folder;
			folderRule = r.id;
		}
		if (r.important || r.critical) importantRules.push(r.id);
		if (r.critical) critical = true;
		if (r.markRead) read = true;
		if (r.markDone) done = true;
	}
	return {
		folder: folder ?? FALLBACK_FOLDER,
		level: critical
			? "critical"
			: importantRules.length > 0
				? "important"
				: "normal",
		// Important mail needs someone, so it never arrives read.
		read: done || (read && importantRules.length === 0),
		done,
		folderRule,
		importantRules,
	};
}

const FIELD_NAMES: Record<Condition["field"], string> = {
	subject: "Subject",
	sender: "Sender",
	body: "Body",
	market: "Marketplace",
};
export const fieldName = (f: Condition["field"]) => FIELD_NAMES[f];

const MARKET_NAMES: Record<MarketChoice, string> = {
	amazon: "Amazon",
	ebay: "eBay",
	tiktok: "TikTok Shop",
	shopify: "Shopify",
	other: "none",
};
export const marketName = (m: MarketChoice) => MARKET_NAMES[m];

// A condition in a few words: "Subject has refund*, rma +3".
export function describe(c: Condition, shown = 3) {
	const list = c.field === "market" ? c.is.map(marketName) : c.has;
	const more = list.length > shown ? ` +${list.length - shown}` : "";
	const verb =
		c.field === "market" ? (c.not ? "isn't" : "is") : c.not ? "lacks" : "has";
	return `${fieldName(c.field)} ${verb} ${list.slice(0, shown).join(", ")}${more}`;
}

// All of a rule's conditions in a few words, joined as it matches them.
export const describeAll = (r: Pick<Rule, "conditions" | "match">) =>
	r.conditions
		.map((c) => describe(c))
		.join(r.match === "any" ? " or " : " and ");
