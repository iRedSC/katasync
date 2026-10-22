import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "#/db/client";
import { marketEmails } from "#/db/schema";
import { moveTo, setDone, setImportant, setRead } from "#/inbox/market-mail";
import {
	createRule,
	deleteRule,
	listRules,
	previewRule,
	reorderRules,
	updateRule,
} from "#/inbox/rule-store";
import { conditionSchema, FOLDERS, MATCHES } from "#/inbox/rules";
import { json, READ, WRITE } from "./tool-shapes";

// The rules that sort the marketplaces mailbox on the Inbox page, and its
// emails one at a time, so Claude can fix mail sorted wrong: one email by
// moving it, all like it by a rule.

const SEMANTICS =
	"Rules run in order (position, smaller first). Each has conditions; match all (the default) needs every one to hold, match any needs one. A text condition (subject, sender = name and address, body) holds when the text has any of its terms: whole words or phrases, case-insensitive, a trailing * matching any ending (violat* = violation, violated); a market condition when the email's marketplace is any listed (other = none). not inverts one. The first matching rule with a folder decides the email's folder (none: updates); every matching rule with important marks it important, and one with critical marks it critical (critical needs someone now: important too, shown red on the Inbox page; save critical alone and it marks both); one with markRead (mark_read when saving) has it arrive read, only as it arrives and never when a rule marks it important. Emails staff moved or marked by hand keep that. Body text carries footers (\"see our return policy\"), so prefer subject and sender.";

export function registerMailRuleReadTools(server: McpServer, db: Db) {
	server.registerTool(
		"mail_rules",
		{
			description: `The rules that sort the marketplaces mailbox (market_emails) into folders orders, returns, violations, updates, and mark emails important, in order. ${SEMANTICS} by is who wrote each last (staff or claude).`,
			inputSchema: {},
			annotations: READ,
		},
		async () => json(await listRules(db)),
	);
}

const ruleInput = {
	name: z.string().min(1).max(80),
	match: z
		.enum(MATCHES)
		.optional()
		.describe("all (default): every condition holds; any: one is enough"),
	conditions: z.array(conditionSchema).min(1).max(10),
	folder: z
		.enum(FOLDERS)
		.nullable()
		.describe("Moves to it; null leaves the folder"),
	important: z.boolean().describe("Marks matching emails important"),
	critical: z
		.boolean()
		.optional()
		.describe("Marks matching emails critical, which is important too"),
	mark_read: z
		.boolean()
		.optional()
		.describe(
			"Matching emails arrive already read. Only as they arrive: saving never marks mail already in",
		),
};

export function registerMailRuleWriteTools(server: McpServer, db: Db) {
	server.registerTool(
		"save_mail_rule",
		{
			description: `Adds a rule sorting the marketplaces mailbox, or with id replaces that one, then sorts every email again (except those staff moved or marked by hand). New rules go last, or before the rule with id before; to fix mail a broader rule catches, put the narrower rule before it. ${SEMANTICS} With dry_run, saves nothing and returns how many emails the rule matches and the newest of them, with each one's folder now: check a rule this way first. Returns how many emails moved and how many changed importance. Staff see it on the Inbox page as written by Claude.`,
			inputSchema: {
				id: z.number().int().positive().optional(),
				...ruleInput,
				before: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("A new rule's place: before this rule id"),
				dry_run: z.boolean().optional(),
			},
			annotations: WRITE,
		},
		async ({ id, before, dry_run, mark_read, ...input }) => {
			const rule = { ...input, markRead: mark_read ?? false };
			if (dry_run) return json(await previewRule(db, rule, 15));
			return json(
				id === undefined
					? await createRule(db, rule, "claude", before)
					: await updateRule(db, id, rule, "claude"),
			);
		},
	);

	server.registerTool(
		"delete_mail_rule",
		{
			description:
				"Deletes a rule sorting the marketplaces mailbox, then sorts every email again without it. Returns the rule as it was (to save it again if wrong) and how many emails moved.",
			inputSchema: { id: z.number().int().positive() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ id }) => json(await deleteRule(db, id)),
	);

	server.registerTool(
		"reorder_mail_rules",
		{
			description:
				"Puts the marketplaces mailbox's rules in this order, every rule id once (mail_rules lists them), then sorts every email again.",
			inputSchema: { ids: z.array(z.number().int().positive()).min(1) },
			annotations: WRITE,
		},
		async ({ ids }) => json(await reorderRules(db, ids)),
	);

	server.registerTool(
		"sort_marketplace_email",
		{
			description:
				'Fixes one email in the marketplaces mailbox (an id from market_emails): folder moves it there and keeps it there whatever the rules say; important marks it important (true), critical ("critical", important too), or neither (false), likewise; "rules" for either hands it back to the rules. read marks it read or unread (the Inbox page counts unread emails). done true takes it off its folder\'s list (staff are done with it), false puts it back. To fix every email like it, save_mail_rule instead.',
			inputSchema: {
				id: z.number().int().positive(),
				folder: z.enum([...FOLDERS, "rules"]).optional(),
				important: z
					.union([z.boolean(), z.literal("critical"), z.literal("rules")])
					.optional(),
				read: z.boolean().optional(),
				done: z.boolean().optional(),
			},
			annotations: WRITE,
		},
		async ({ id, folder, important, read, done }) => {
			if ([folder, important, read, done].every((x) => x === undefined))
				throw new Error("Give folder, important, read, or done");
			if (read !== undefined) await setRead(db, id, read);
			if (folder !== undefined)
				await moveTo(db, id, folder === "rules" ? null : folder);
			if (important !== undefined)
				await setImportant(
					db,
					id,
					important === "rules"
						? null
						: important === "critical"
							? "critical"
							: important
								? "important"
								: "normal",
				);
			if (done !== undefined) await setDone(db, id, done);
			const [now] = await db
				.select({
					id: marketEmails.id,
					folder: marketEmails.folder,
					important: marketEmails.important,
					critical: marketEmails.critical,
					done: sql<boolean>`${marketEmails.doneAt} is not null`,
					read: sql<boolean>`${marketEmails.readAt} is not null`,
					byHand: sql<boolean>`${marketEmails.relabelledAt} is not null or ${marketEmails.importanceSetAt} is not null`,
				})
				.from(marketEmails)
				.where(eq(marketEmails.id, id));
			return json(now);
		},
	);
}
