import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { marketEmails } from "#/db/schema";
import { callTool, freshDb } from "./mcp.fixtures";

// Claude fixing how the marketplaces mailbox is sorted: a rule for all mail
// like it, tried first, and one email by hand.

let db: Db;
let emailId: number;
beforeEach(async () => {
	({ db } = await freshDb());
	const [row] = await db
		.insert(marketEmails)
		.values({
			messageId: "<1>",
			market: "amazon",
			folder: "updates",
			fromAddress: "payments@amazon.com",
			recipients: [],
			subject: "Your disbursement was sent",
			body: "",
			receivedAt: new Date(),
		})
		.returning({ id: marketEmails.id });
	emailId = row.id;
});

const rule = {
	name: "Disbursements matter",
	conditions: [{ field: "subject", has: ["disbursement*"] }],
	folder: null,
	important: true,
};

describe("mail rules over MCP", () => {
	test("read-only apps see the rules but can't change them", async () => {
		const { data } = await callTool(db, false, "mail_rules", {});
		expect(data[0]).toMatchObject({ name: "Violations and account health" });
		const { isError } = await callTool(db, false, "save_mail_rule", rule);
		expect(isError).toBe(true);
	});

	test("a rule can have mail arrive read", async () => {
		const saved = await callTool(db, true, "save_mail_rule", {
			...rule,
			important: false,
			mark_read: true,
		});
		expect(saved.isError).toBe(false);
		const rules = (await callTool(db, true, "mail_rules", {})).data;
		expect(rules.at(-1)).toMatchObject({ markRead: true, important: false });
	});

	test("a dry run saves nothing; saving sorts the mail", async () => {
		const tried = await callTool(db, true, "save_mail_rule", {
			...rule,
			dry_run: true,
		});
		expect(tried.data).toMatchObject({ count: 1 });
		expect((await callTool(db, true, "mail_rules", {})).data).toHaveLength(5);

		const saved = await callTool(db, true, "save_mail_rule", rule);
		expect(saved.data).toMatchObject({ moved: 0, marked: 1 });
		const rules = (await callTool(db, true, "mail_rules", {})).data;
		expect(rules.at(-1)).toMatchObject({ by: "claude", important: true });
	});

	test("one email by hand, and back to the rules", async () => {
		const moved = await callTool(db, true, "sort_marketplace_email", {
			id: emailId,
			folder: "orders",
			important: true,
		});
		expect(moved.data).toMatchObject({
			folder: "orders",
			important: true,
			byHand: true,
		});
		const back = await callTool(db, true, "sort_marketplace_email", {
			id: emailId,
			folder: "rules",
			important: "rules",
		});
		const read = await callTool(db, true, "sort_marketplace_email", {
			id: emailId,
			read: true,
		});
		expect(read.data).toMatchObject({ read: true });
		expect(back.data).toMatchObject({
			folder: "updates",
			important: false,
			byHand: false,
		});
	});
});
