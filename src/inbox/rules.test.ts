import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { mailRules, marketEmails } from "#/db/schema";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import { createTestDb } from "#/test/db";
import { ingestMarketMail, marketMailPage, setRead } from "./market-mail";
import {
	createRule,
	deleteRule,
	listRules,
	previewRule,
	RuleError,
	reorderRules,
	restoreRule,
	updateRule,
} from "./rule-store";
import {
	type Condition,
	matches,
	ruleSchema,
	type Sortable,
	sortEmail,
} from "./rules";

const email = (subject: string, more: Partial<Sortable> = {}): Sortable => ({
	subject,
	fromAddress: "seller-notification@amazon.com",
	fromName: "Amazon",
	body: "",
	market: "amazon",
	...more,
});
const has = (field: "subject" | "sender" | "body", ...terms: string[]) =>
	({ field, has: terms, not: false }) satisfies Condition;
const when = (...conditions: Condition[]) => ({
	match: "all" as const,
	conditions,
});

describe("a condition", () => {
	test("matches whole words, stems with *, and phrases", () => {
		expect(
			matches(when(has("subject", "case")), email("Case 123 opened")),
		).toBe(true);
		expect(matches(when(has("subject", "case")), email("Our showcase"))).toBe(
			false,
		);
		expect(
			matches(when(has("subject", "violat*")), email("Policy violations")),
		).toBe(true);
		expect(
			matches(when(has("subject", "act now")), email("Please ACT   now")),
		).toBe(true);
		expect(matches(when(has("subject", "a-to-z")), email("A-to-z claim"))).toBe(
			true,
		);
	});

	test("a * only ends a word; one saved anywhere else is a plain character", () => {
		const rule = (term: string) =>
			ruleSchema.safeParse({
				name: "x",
				conditions: [has("subject", term)],
				folder: "orders",
				important: false,
			}).success;
		expect(rule("violat*")).toBe(true);
		expect(rule("vi*lat")).toBe(false);
		expect(rule("a*a*b")).toBe(false);
		expect(rule("violat**")).toBe(false);

		// Saved before the schema refused it: matched literally, and at once.
		const old = when(has("subject", `${"a*".repeat(10)}b`));
		const started = performance.now();
		expect(matches(old, email(`${"a".repeat(45)}!`))).toBe(false);
		expect(performance.now() - started).toBeLessThan(50);
		expect(matches(old, email(`${"a*".repeat(10)}b`))).toBe(true);
	});

	test("reads the sender's name and address, symbols and all", () => {
		const c = when(has("sender", "@amazon.com"));
		expect(matches(c, email("x"))).toBe(true);
		expect(matches(c, email("x", { fromAddress: "a@notamazon.com" }))).toBe(
			false,
		);
		expect(matches(when(has("sender", "amazon")), email("x"))).toBe(true);
	});

	test("not, markets, and all conditions together", () => {
		const rule = when(
			{ field: "market", is: ["ebay", "other"], not: false },
			{ field: "subject", has: ["refund"], not: true },
		);
		expect(matches(rule, email("Sold", { market: "ebay" }))).toBe(true);
		expect(matches(rule, email("Sold", { market: null }))).toBe(true);
		expect(matches(rule, email("Refund", { market: "ebay" }))).toBe(false);
		expect(matches(rule, email("Sold"))).toBe(false);
	});

	test("any needs only one to hold", () => {
		const rule = {
			match: "any" as const,
			conditions: [has("subject", "refund"), has("sender", "ebay.com")],
		};
		expect(matches(rule, email("Refund issued"))).toBe(true);
		expect(matches(rule, email("Sold", { fromAddress: "ebay@ebay.com" }))).toBe(
			true,
		);
		expect(matches(rule, email("Sold"))).toBe(false);
	});
});

describe("a rule", () => {
	test("must do something and have conditions", () => {
		const ok = {
			name: "x",
			conditions: [has("subject", "x")],
			folder: null,
			important: true,
		};
		expect(ruleSchema.safeParse(ok).success).toBe(true);
		expect(ruleSchema.safeParse({ ...ok, important: false }).success).toBe(
			false,
		);
		expect(ruleSchema.safeParse({ ...ok, conditions: [] }).success).toBe(false);
		// Critical alone is important too.
		expect(
			ruleSchema.parse({ ...ok, important: false, critical: true }),
		).toMatchObject({ important: true, critical: true, match: "all" });
		expect(
			ruleSchema.safeParse({
				...ok,
				conditions: [{ field: "subject", has: [] }],
			}).success,
		).toBe(false);
	});
});

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});

describe("the default rules", () => {
	test("sort as katasync did, important apart from folder", async () => {
		const rules = await listRules(db);
		const sorted = (s: string) => {
			const r = sortEmail(rules, email(s));
			return [r.folder, r.level !== "normal"];
		};
		expect(sorted("Policy Warning: Listing removed")).toEqual([
			"violations",
			true,
		]);
		expect(sorted("Your Amazon.com listing has been suppressed")).toEqual([
			"violations",
			true,
		]);
		expect(sorted("A buyer opened a dispute on order 123")).toEqual([
			"orders",
			true,
		]);
		expect(sorted("Action required: verify your identity")).toEqual([
			"updates",
			true,
		]);
		expect(sorted("Activate Your Account as Shop User")).toEqual([
			"updates",
			true,
		]);
		expect(sorted("Sold, ship now: Drywall Banjo")).toEqual(["orders", false]);
		expect(sorted("You made a sale!")).toEqual(["orders", false]);
		expect(sorted("Order 112-3 has been cancelled")).toEqual(["orders", false]);
		expect(sorted("Refund Initiated for Order 111-2762240")).toEqual([
			"returns",
			false,
		]);
		expect(sorted("Return request for Drywall Banjo")).toEqual([
			"returns",
			false,
		]);
		expect(sorted("A-to-z claim on your return")).toEqual(["returns", true]);
		expect(sorted("Your payout is on its way")).toEqual(["updates", false]);
		expect(sorted("New features for sellers")).toEqual(["updates", false]);
		// Order notices arrive read, unless something marks them important.
		expect(sortEmail(rules, email("You made a sale!")).read).toBe(true);
		expect(
			sortEmail(rules, email("A buyer opened a dispute on order 1")).read,
		).toBe(false);
		expect(sortEmail(rules, email("Your payout is on its way")).read).toBe(
			false,
		);
	});
});

describe("keeping rules", () => {
	const rule = {
		name: "eBay payouts",
		conditions: [has("subject", "payout")],
		folder: "orders" as const,
		important: false,
		markRead: false,
	};

	test("a new rule goes last, or before another, and sorts the mail", async () => {
		await db.insert(marketEmails).values({
			messageId: "<1>",
			market: "ebay",
			folder: "updates",
			fromAddress: "ebay@ebay.com",
			recipients: [],
			subject: "Your payout is on its way",
			body: "",
			receivedAt: new Date(),
		});
		const before = await listRules(db);
		const { id, moved } = await createRule(db, rule, "claude", before[1].id);
		expect(moved).toBe(1);
		const after = await listRules(db);
		expect(after.map((r) => r.id)).toEqual([
			before[0].id,
			id,
			...before.slice(1).map((r) => r.id),
		]);
		expect(after[1]).toMatchObject({ by: "claude", name: "eBay payouts" });
		expect(await previewRule(db, rule)).toMatchObject({
			count: 1,
			emails: [
				{
					subject: "Your payout is on its way",
					folder: "orders",
					from: "ebay@ebay.com",
				},
			],
		});

		await updateRule(
			db,
			id,
			{ ...rule, folder: null, important: true },
			"staff",
		);
		expect((await db.select().from(marketEmails))[0]).toMatchObject({
			folder: "updates",
			important: true,
		});

		const { rule: gone, before: next } = await deleteRule(db, id);
		expect((await db.select().from(marketEmails))[0].important).toBe(false);
		// Reordered meanwhile, it still goes back before the rule it ran before.
		await reorderRules(
			db,
			[...(await listRules(db)).map((r) => r.id)].reverse(),
		);
		await restoreRule(db, { ...rule, before: next, by: gone.by });
		const back = await listRules(db);
		const at = back.findIndex((r) => r.name === "eBay payouts");
		expect(back[at + 1].id).toBe(next);
		expect(new Set(back.map((r) => r.position)).size).toBe(back.length);
	});

	test("a critical rule marks mail critical and important, and stays first in line", async () => {
		await db.insert(marketEmails).values({
			messageId: "<1>",
			market: "ebay",
			folder: "updates",
			fromAddress: "ebay@ebay.com",
			recipients: [],
			subject: "Your payout is on its way",
			body: "",
			receivedAt: new Date(),
		});
		const { id, marked } = await createRule(
			db,
			{ ...rule, critical: true },
			"staff",
		);
		expect(marked).toBe(1);
		expect((await db.select().from(marketEmails))[0]).toMatchObject({
			important: true,
			critical: true,
		});
		// Down to important, it stops being critical.
		await updateRule(db, id, { ...rule, important: true }, "staff");
		expect((await db.select().from(marketEmails))[0]).toMatchObject({
			important: true,
			critical: false,
		});
		const counts = (await marketMailPage(db, "important", null)).counts;
		expect(counts).toMatchObject({ important: 1, critical: 0 });
	});

	test("critical without important can't be stored", async () => {
		await expect(
			db.insert(marketEmails).values({
				messageId: "<2>",
				folder: "updates",
				fromAddress: "x@ebay.com",
				recipients: [],
				subject: "x",
				body: "",
				receivedAt: new Date(),
				critical: true,
			}),
		).rejects.toThrow();
	});

	test("reordering needs every rule once", async () => {
		const ids = (await listRules(db)).map((r) => r.id);
		await expect(reorderRules(db, ids.slice(1))).rejects.toThrow(RuleError);
		await reorderRules(db, [...ids].reverse());
		expect((await listRules(db)).map((r) => r.id)).toEqual([...ids].reverse());
	});

	test("one that does nothing isn't kept, even past the code", async () => {
		await expect(
			createRule(db, { ...rule, folder: null }, "staff"),
		).rejects.toThrow(RuleError);
		await expect(
			db
				.insert(mailRules)
				.values({ position: 1, name: "x", conditions: [], important: true }),
		).rejects.toThrow();
	});
});

describe("read", () => {
	test("a rule has mail arrive read, and never touches mail already in", async () => {
		const add = (subject: string) =>
			ingestMarketMail(db, [message(subject)], async () => ({
				body: "",
				attachments: [],
			}));
		await add("Your payout is on its way");
		await createRule(
			db,
			{
				name: "Payouts read",
				conditions: [has("subject", "payout")],
				folder: null,
				important: false,
				markRead: true,
			},
			"staff",
		);
		await add("Another payout");
		const rows = (await db.select().from(marketEmails)).sort(
			(a, b) => a.id - b.id,
		);
		expect(rows.map((r) => r.readAt !== null)).toEqual([false, true]);

		// Only unread open mail counts.
		expect((await marketMailPage(db, "updates", null)).counts.updates).toBe(1);
		await setRead(db, rows[0].id, true);
		expect((await marketMailPage(db, "updates", null)).counts.updates).toBe(0);
		await setRead(db, rows[1].id, false);
		expect((await marketMailPage(db, "updates", null)).counts.updates).toBe(1);
	});
});

describe("done", () => {
	test("a rule has mail arrive done and read, even when another marks it important", async () => {
		const add = (subject: string) =>
			ingestMarketMail(db, [message(subject)], async () => ({
				body: "",
				attachments: [],
			}));
		await createRule(
			db,
			{
				name: "Copies are done",
				conditions: [has("subject", "your e-mail to")],
				folder: null,
				important: false,
				markDone: true,
			},
			"staff",
		);
		await createRule(
			db,
			{
				name: "Mail is important",
				conditions: [has("subject", "e-mail")],
				folder: null,
				important: true,
			},
			"staff",
		);
		await add("Your e-mail to Rick");
		await add("An e-mail about your account");
		const rows = (await db.select().from(marketEmails)).sort(
			(a, b) => a.id - b.id,
		);
		expect(
			rows.map((r) => [r.doneAt !== null, r.readAt !== null, r.important]),
		).toEqual([
			[true, true, true],
			[false, false, true],
		]);
	});
});

let n = 0;
const message = (subject: string): InboxMessage => {
	n++;
	return {
		graphId: `g${n}`,
		messageId: `<${n}@mail>`,
		receivedAt: new Date(Date.UTC(2026, 9, 21, 12, n)),
		subject,
		fromAddress: "payments@amazon.com",
		fromName: null,
		recipients: [],
	};
};
