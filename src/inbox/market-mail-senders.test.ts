import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { buyerMessages, marketEmails } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { readMarketMail } from "./market-mail";

// The cron's read of the mailbox asks Microsoft who vouched for each buyer
// email's sender, so Amazon's relayed buyer messages reach their threads;
// a sweep asks again for emails kept without asking.

const INBOX = "marketplaces@eastcoastdrywall.com";
const RELAY = "p39fytvw2631s9q+f12f@marketplace.amazon.com";
const SUBJECT =
	"Inquiry from Amazon customer Rick (Order: 113-1228890-8225003)";
const PASSED =
	"spf=pass smtp.mailfrom=marketplace.amazon.com; dkim=pass header.d=marketplace.amazon.com;dmarc=pass action=none header.from=marketplace.amazon.com;compauth=pass reason=100";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("MS_GRAPH_TENANT_ID", "t");
	vi.stubEnv("MS_GRAPH_CLIENT_ID", "c");
	vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "s");
	vi.stubEnv("MARKETPLACE_INBOX", INBOX);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

// Microsoft 365 with `listed` new, every email's headers vouching for it,
// and anything kept found again under its Graph id.
function mailbox(listed: object[]) {
	const asked: string[] = [];
	vi.stubGlobal("fetch", async (input: string) => {
		const url = decodeURIComponent(input);
		asked.push(url);
		if (url.includes("login.microsoftonline.com"))
			return Response.json({ access_token: "token", expires_in: 3600 });
		if (url.includes("$filter=receivedDateTime"))
			return Response.json({ value: listed });
		if (url.includes("$filter=internetMessageId"))
			return Response.json({ value: [{ id: "g-kept" }] });
		if (url.includes("$select=internetMessageHeaders"))
			return Response.json({
				internetMessageHeaders: [
					{ name: "Authentication-Results", value: PASSED },
				],
			});
		if (url.includes("/attachments")) return Response.json({ value: [] });
		if (url.includes("$select=body"))
			return Response.json({
				body: { content: "Message:\n\nWhere is my order?\n\nView Message" },
			});
		return Response.json({ error: { message: url } }, { status: 404 });
	});
	return asked;
}

describe("reading the mailbox", () => {
	test("asks who sent a relayed buyer message, and files it", async () => {
		const asked = mailbox([
			{
				id: "g1",
				internetMessageId: "<relay1@amazon>",
				receivedDateTime: new Date().toISOString(),
				subject: SUBJECT,
				from: { emailAddress: { address: RELAY } },
				toRecipients: [{ emailAddress: { address: INBOX } }],
			},
		]);
		const result = await readMarketMail({
			since: new Date(),
			sweep: false,
			db: () => db,
		});
		expect(result).toMatchObject({ read: 1, threaded: 1 });
		expect(asked.some((u) => u.includes("internetMessageHeaders"))).toBe(true);
		const [email] = await db.select().from(marketEmails);
		expect(email).toMatchObject({ senderAuthenticated: true });
		expect(email?.senderCheckedAt).toBeInstanceOf(Date);
		expect(await db.select().from(buyerMessages)).toHaveLength(1);
	});

	test("a sweep asks again for one kept without asking, then files it", async () => {
		const [kept] = await db
			.insert(marketEmails)
			.values({
				messageId: "<relay2@amazon>",
				market: "amazon",
				folder: "updates",
				fromAddress: RELAY,
				recipients: [INBOX],
				subject: SUBJECT,
				body: "Message:\n\nStill waiting\n\nView Message",
				receivedAt: new Date(Date.now() - 86_400_000),
			})
			.returning();
		mailbox([]);
		const result = await readMarketMail({
			since: new Date(),
			sweep: true,
			db: () => db,
		});
		expect(result).toMatchObject({ rechecked: 1, threaded: 1 });
		const [after] = await db
			.select()
			.from(marketEmails)
			.where(eq(marketEmails.id, kept?.id ?? 0));
		expect(after).toMatchObject({ senderAuthenticated: true });
		expect(after?.senderCheckedAt).toBeInstanceOf(Date);
		expect(await db.select().from(buyerMessages)).toHaveLength(1);
	});

	test("one gone from the mailbox is asked once, and not vouched for", async () => {
		await db.insert(marketEmails).values({
			messageId: "<gone@amazon>",
			market: "amazon",
			folder: "updates",
			fromAddress: RELAY,
			recipients: [INBOX],
			subject: SUBJECT,
			body: "Message:\n\nHello\n\nView Message",
			receivedAt: new Date(Date.now() - 86_400_000),
		});
		mailbox([]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) =>
				input.includes("login.microsoftonline.com")
					? Response.json({ access_token: "token", expires_in: 3600 })
					: Response.json({ value: [] }),
			),
		);
		await readMarketMail({ since: new Date(), sweep: true, db: () => db });
		const [after] = await db.select().from(marketEmails);
		expect(after).toMatchObject({ senderAuthenticated: false });
		expect(after?.senderCheckedAt).toBeInstanceOf(Date);
		expect(await db.select().from(buyerMessages)).toEqual([]);
	});
});
