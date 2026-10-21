import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { emailTemplates } from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";

// The wording of each email katasync sends suppliers. Staff edit the subject
// and body in Settings; {placeholders} are filled in per email, and the parts
// katasync lays out ({damage_list}) come in whole. A template that names a
// placeholder its email doesn't have, or leaves out one it needs, can't be
// saved, so no email goes out with "{contct}" or without its damage list.

export const TEMPLATE_KINDS = ["purchase_order", "damage_report"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export type Template = { subject: string; body: string };

const COMMON = {
	greeting: "“Hi Sam,” or “Hello,” when the supplier has no contact",
	po: "The PO number",
	supplier: "The supplier's name",
	from: "Our name on the PO, e.g. East Coast Drywall Tools",
} as const;

// What each email can say, and what each placeholder becomes.
export const PLACEHOLDERS = {
	purchase_order: {
		...COMMON,
		items: "How many lines: “3 items”",
	},
	damage_report: {
		...COMMON,
		damage_list: "Each damaged item, what's wrong, and what we ask for",
		photos: "“2 photos are attached.”, or nothing without photos",
	},
} as const satisfies Record<TemplateKind, Record<string, string>>;

export type Values<K extends TemplateKind> = Record<
	keyof (typeof PLACEHOLDERS)[K],
	string
>;

// In the body exactly once; never in the subject.
const REQUIRED: Record<TemplateKind, string[]> = {
	purchase_order: [],
	damage_report: ["damage_list"],
};

export const TEMPLATE_NAMES: Record<TemplateKind, string> = {
	purchase_order: "Purchase order",
	damage_report: "Damage report",
};

export const DEFAULT_TEMPLATES: Record<TemplateKind, Template> = {
	purchase_order: {
		subject: "Purchase order {po} from {from}",
		body: [
			"{greeting}",
			"",
			"Please find purchase order {po} attached ({items}). Reply to this email to confirm, or with any changes or backorders.",
			"",
			"Thank you,",
			"{from}",
		].join("\n"),
	},
	damage_report: {
		subject: "Damage on purchase order {po} from {from}",
		body: [
			"{greeting}",
			"",
			"Some of what arrived on purchase order {po} was damaged:",
			"",
			"{damage_list}",
			"",
			"{photos}",
			"",
			"Thank you,",
			"{from}",
		].join("\n"),
	},
};

const TOKEN = /\{([a-z_]+)\}/g;

// What's wrong with a template, in words for the editor; empty when it can
// be saved.
export function templateProblems(kind: TemplateKind, t: Template) {
	const problems: string[] = [];
	if (!t.subject.trim()) problems.push("The subject is empty");
	if (!t.body.trim()) problems.push("The body is empty");
	const known = Object.keys(PLACEHOLDERS[kind]);
	const unknown = new Set(
		[...`${t.subject}\n${t.body}`.matchAll(TOKEN)]
			.map((m) => m[1])
			.filter((name) => !known.includes(name)),
	);
	for (const name of unknown)
		problems.push(`{${name}} isn't a placeholder this email has`);
	for (const name of REQUIRED[kind]) {
		const times = [...t.body.matchAll(TOKEN)].filter(
			(m) => m[1] === name,
		).length;
		if (times !== 1)
			problems.push(
				times === 0
					? `The body needs {${name}}`
					: `{${name}} can only appear once`,
			);
		if (t.subject.includes(`{${name}}`))
			problems.push(`{${name}} can't go in the subject`);
	}
	return problems;
}

// The email itself. Lines a placeholder left empty don't leave a gap.
export function renderTemplate<K extends TemplateKind>(
	t: Template,
	values: Values<K>,
) {
	const fill = (s: string) =>
		s.replace(
			TOKEN,
			(whole, name: string) =>
				(values as Record<string, string>)[name] ?? whole,
		);
	return {
		subject: fill(t.subject).replace(/\s+/g, " ").trim(),
		text: fill(t.body)
			.replace(/[ \t]+$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	};
}

export async function templateFor(
	db: Db,
	kind: TemplateKind,
): Promise<Template & { custom: boolean }> {
	const [row] = await db
		.select()
		.from(emailTemplates)
		.where(eq(emailTemplates.kind, kind));
	return row
		? { subject: row.subject, body: row.body, custom: true }
		: { ...DEFAULT_TEMPLATES[kind], custom: false };
}

export async function allTemplates(db: Db) {
	return Promise.all(
		TEMPLATE_KINDS.map(async (kind) => ({
			kind,
			...(await templateFor(db, kind)),
		})),
	);
}

export async function saveTemplate(db: Db, kind: TemplateKind, t: Template) {
	const problems = templateProblems(kind, t);
	if (problems.length > 0) throw new PurchaseOrderError(problems.join(". "));
	const saved = { subject: t.subject.trim(), body: t.body.trim() };
	await db
		.insert(emailTemplates)
		.values({ kind, ...saved })
		.onConflictDoUpdate({
			target: emailTemplates.kind,
			set: { ...saved, updatedAt: new Date() },
		});
	return saved;
}

// Back to the default wording.
export async function resetTemplate(db: Db, kind: TemplateKind) {
	await db.delete(emailTemplates).where(eq(emailTemplates.kind, kind));
	return DEFAULT_TEMPLATES[kind];
}

export const greetingFor = (contactName: string | null) =>
	contactName ? `Hi ${contactName},` : "Hello,";
