import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { buyerMessages, marketEmails } from "#/db/schema";
import { ingestMarketMail, marketMailPage } from "#/inbox/market-mail";
import type { Header } from "#/inbox/sender-auth";
import { createTestDb } from "#/test/db";
import { threadAmazonCopies, threadAmazonMail } from "./amazon-mail";

// Anyone can send the marketplaces mailbox an email "from" Amazon's relay;
// only one Microsoft vouched for becomes a buyer message.

const RELAY = "p39fytvw2631s9q+f12f@marketplace.amazon.com";
const INBOX = "marketplaces@eastcoastdrywall.com";
const SUBJECT =
	"Inquiry from Amazon customer Rick (Order: 113-1228890-8225003)";
const BODY = "Message:\n\nWhere is my order?\n\nView Message";

let db: Db;
let n = 0;
beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("MARKETPLACE_INBOX", INBOX);
});
afterEach(() => vi.unstubAllEnvs());

const passed: Header[] = [
	{
		name: "Authentication-Results",
		value:
			"spf=pass smtp.mailfrom=marketplace.amazon.com; dkim=pass header.d=marketplace.amazon.com;dmarc=pass action=none header.from=marketplace.amazon.com;compauth=pass reason=100",
	},
];
const forged: Header[] = [
	{
		name: "Authentication-Results",
		value:
			"spf=fail smtp.mailfrom=evil.test; dkim=none;dmarc=fail action=quarantine header.from=marketplace.amazon.com;compauth=fail reason=000",
	},
];

// An email read in through the mailbox as the cron does, with its headers.
async function arrive(
	headers: Header[],
	over: { subject?: string; body?: string; from?: string } = {},
) {
	n++;
	await ingestMarketMail(
		db,
		[
			{
				graphId: `g${n}`,
				messageId: `<a${n}@amazon>`,
				receivedAt: new Date(Date.UTC(2026, 9, 22, 16, n)),
				subject: over.subject ?? SUBJECT,
				fromAddress: over.from ?? RELAY,
				fromName: null,
				recipients: [INBOX],
			},
		],
		async () => ({ body: over.body ?? BODY, attachments: [] }),
		async () => headers,
	);
}

const messages = () => db.select().from(buyerMessages);

describe("Amazon's buyer relay", () => {
	test("an email Microsoft vouched came from Amazon is filed", async () => {
		await arrive(passed);
		expect(await threadAmazonMail(db)).toBe(1);
		expect(await messages()).toHaveLength(1);
		// The rules close it on arrival: it's answered in Buyers.
		const { emails } = await marketMailPage(db, "done", null);
		expect(emails.map((e) => e.unverified)).toEqual([null]);
	});

	test("a forged From stays in the mailbox, marked unverified", async () => {
		await arrive(forged);
		expect(await threadAmazonMail(db)).toBe(0);
		expect(await messages()).toEqual([]);
		// Open and unread in its folder, though the rules close real ones.
		const [kept] = await db
			.select({
				folder: marketEmails.folder,
				doneAt: marketEmails.doneAt,
				readAt: marketEmails.readAt,
			})
			.from(marketEmails);
		expect(kept).toMatchObject({ doneAt: null, readAt: null });
		const { emails } = await marketMailPage(
			db,
			kept?.folder ?? "updates",
			null,
		);
		expect(emails.map((e) => e.unverified)).toEqual([
			"Not put on a buyer thread: Microsoft couldn't confirm Amazon sent it",
		]);
	});

	test("no Authentication-Results at all isn't vouched for", async () => {
		await arrive([]);
		expect(await threadAmazonMail(db)).toBe(0);
		expect(await messages()).toEqual([]);
	});

	test("a forged copy of ours in Seller Central adds nothing", async () => {
		await arrive(forged, {
			from: "donotreply@amazon.com",
			subject: "Your e-mail to Rick",
			body: "Order ID: 113-1228890-8225003\n----- Begin message -----\nRefund sent\n----- End message -----",
		});
		expect(await threadAmazonCopies(db)).toBe(0);
		expect(await messages()).toEqual([]);
	});
});
