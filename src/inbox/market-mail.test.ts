import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { marketEmails } from "#/db/schema";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import { createTestDb } from "#/test/db";
import {
	countImportant,
	ingestMarketMail,
	marketMailPage,
	marketOf,
	marketOfEmail,
	moveTo,
	readMarketMail,
	setDone,
	setImportant,
	sweepSince,
} from "./market-mail";
import { createRule, listRules, resort } from "./rule-store";

describe("by sender", () => {
	test("which marketplace", () => {
		expect(marketOf("seller-notification@amazon.com")).toBe("amazon");
		expect(marketOf("donotreply@marketplace.amazon.com")).toBe("amazon");
		expect(marketOf("ebay@ebay.com")).toBe("ebay");
		expect(marketOf("noreply@seller-us.tiktokshop.com")).toBe("tiktok");
		expect(marketOf("mailer@shopify.com")).toBe("shopify");
		// Lookalikes aren't the marketplace.
		expect(marketOf("deals@notamazon.com")).toBeNull();
		expect(marketOf("someone@gmail.com")).toBeNull();
	});
});

describe("Shopify's order notices", () => {
	beforeEach(() => {
		vi.stubEnv("MARKETPLACE_INBOX", "marketplaces@example.com");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	const subject =
		"[East Coast Drywall Tools] Order #5754 placed by M***** A*****";

	test("sent as the mailbox, they're Shopify's", () => {
		expect(
			marketOfEmail({ fromAddress: "Marketplaces@example.com", subject }),
		).toBe("shopify");
	});

	test("the same subject from anyone else isn't", () => {
		expect(
			marketOfEmail({ fromAddress: "someone@gmail.com", subject }),
		).toBeNull();
	});

	test("other mail we send isn't", () => {
		expect(
			marketOfEmail({
				fromAddress: "marketplaces@example.com",
				subject: "Re: Order #5754",
			}),
		).toBeNull();
	});
});

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

let n = 0;
const message = (subject: string, from = "seller@amazon.com"): InboxMessage => {
	n++;
	return {
		graphId: `g${n}`,
		messageId: `<${n}@mail>`,
		receivedAt: new Date(Date.UTC(2026, 9, 21, 12, n)),
		subject,
		fromAddress: from,
		fromName: null,
		recipients: ["marketplaces@eastcoastdrywall.com"],
	};
};
const read = async () => ({
	body: "Details",
	attachments: [
		{
			filename: "report.csv",
			contentType: "text/csv",
			size: 3,
			data: Buffer.from("a,b"),
		},
	],
});

describe("the mailbox", () => {
	test("reads each email in once, sorted, with its files", async () => {
		const warning = message("Policy warning on your listing");
		const sold = message("Sold, ship now", "ebay@ebay.com");
		expect(await ingestMarketMail(db, [warning, sold], read)).toEqual({
			read: 2,
			problems: [],
		});
		// The next run sees them again and keeps nothing twice.
		expect((await ingestMarketMail(db, [warning], read)).read).toBe(0);

		const page = await marketMailPage(db, "important", null);
		// The sale arrives read (the default orders rule), so isn't counted.
		expect(page.counts).toEqual({
			important: 1,
			critical: 0,
			violations: 1,
			orders: 0,
			returns: 0,
			updates: 0,
		});
		expect(page.emails).toEqual([
			expect.objectContaining({
				market: "amazon",
				folder: "violations",
				important: true,
				why: {
					folder: {
						rule: expect.any(Number),
						name: "Violations and account health",
					},
					important: [
						{ rule: expect.any(Number), name: "Violations and account health" },
					],
				},
				subject: "Policy warning on your listing",
				body: "Details",
				attachments: [
					expect.objectContaining({ filename: "report.csv", kept: true }),
				],
			}),
		]);
		expect(await countImportant(db)).toEqual({ important: 1, critical: 0 });
	});

	test("done leaves its list; moved stays moved; the market filter narrows", async () => {
		await ingestMarketMail(
			db,
			[
				message("Account health at risk"),
				message("Dispute opened", "tt@tiktokshop.com"),
			],
			read,
		);
		const [amazon, tiktok] = (
			await marketMailPage(db, "important", null)
		).emails.sort((a, b) => a.id - b.id);
		await setDone(db, amazon.id, true);
		await moveTo(db, tiktok.id, "orders");
		await setImportant(db, tiktok.id, "normal");

		expect((await marketMailPage(db, "important", null)).emails).toEqual([]);
		expect(
			(await marketMailPage(db, "done", null)).emails.map((e) => e.id),
		).toEqual([amazon.id]);
		const tiktokOrders = await marketMailPage(db, "orders", "tiktok");
		expect(tiktokOrders.emails.map((e) => e.id)).toEqual([tiktok.id]);
		expect((await marketMailPage(db, "orders", "amazon")).emails).toEqual([]);

		await setDone(db, amazon.id, false);
		expect(
			(await marketMailPage(db, "important", "amazon")).counts.important,
		).toBe(1);
	});

	test("a sweep that can't read the mailbox records why, and the page shows it", async () => {
		vi.stubEnv("MS_GRAPH_TENANT_ID", "t");
		vi.stubEnv("MS_GRAPH_CLIENT_ID", "c");
		vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "s");
		vi.stubEnv("MARKETPLACE_INBOX", "marketplaces@eastcoastdrywall.com");
		vi.stubGlobal("fetch", async (url: string) =>
			url.includes("login.microsoftonline.com")
				? Response.json({ access_token: "token", expires_in: 3600 })
				: Response.json(
						{
							error: {
								code: "ErrorAccessDenied",
								message: "Access is denied.",
							},
						},
						{ status: 403 },
					),
		);
		const result = await readMarketMail({
			since: new Date(),
			sweep: true,
			db: () => db,
		});
		expect(result).toEqual({
			error: expect.stringContaining("Access is denied"),
		});
		const page = await marketMailPage(db, "important", null);
		expect(page.connected).toBe(true);
		expect(page.check?.error).toContain("Access is denied");
	});

	test("a run that lists emails but can't read them records why", async () => {
		vi.stubEnv("MS_GRAPH_TENANT_ID", "t");
		vi.stubEnv("MS_GRAPH_CLIENT_ID", "c");
		vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "s");
		vi.stubEnv("MARKETPLACE_INBOX", "marketplaces@eastcoastdrywall.com");
		vi.stubGlobal("fetch", async (url: string) => {
			if (url.includes("login.microsoftonline.com"))
				return Response.json({ access_token: "token", expires_in: 3600 });
			if (url.includes("$filter=receivedDateTime"))
				return Response.json({
					value: [
						{
							id: "g1",
							internetMessageId: "<1@ebay>",
							receivedDateTime: new Date().toISOString(),
							subject: "You made a sale",
							from: { emailAddress: { address: "ebay@ebay.com" } },
						},
					],
				});
			return Response.json(
				{ error: { message: "Bad request" } },
				{ status: 400 },
			);
		});
		const result = await readMarketMail({
			since: new Date(),
			sweep: false,
			db: () => db,
		});
		expect(result).toMatchObject({ read: 0 });
		const page = await marketMailPage(db, "important", null);
		expect(page.check?.error).toContain("You made a sale");
	});

	test("without the mailbox set up, nothing is read", async () => {
		vi.stubEnv("MARKETPLACE_INBOX", "");
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(
			await readMarketMail({ since: new Date(), sweep: false, db: () => db }),
		).toEqual({ skipped: expect.stringContaining("MARKETPLACE_INBOX") });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("by hand", () => {
	test("moved or marked stays so as rules change; handing back re-sorts", async () => {
		await ingestMarketMail(
			db,
			[
				message("Refund Initiated for Order 1"),
				message("Refund Initiated for Order 2"),
			],
			read,
		);
		const [first, second] = (await db.select().from(marketEmails)).sort(
			(a, b) => a.id - b.id,
		);
		expect(first.folder).toBe("returns");
		await moveTo(db, second.id, "updates");
		await setImportant(db, second.id, "important");

		// A rule that sends refunds elsewhere moves the one left to the rules.
		await createRule(
			db,
			{
				name: "Refunds are orders",
				conditions: [{ field: "subject", has: ["refund*"], not: false }],
				folder: "orders",
				important: false,
			},
			"staff",
			(await listRules(db))[0].id,
		);
		const after = await db.select().from(marketEmails);
		const find = (id: number) => after.find((e) => e.id === id);
		expect(find(first.id)).toMatchObject({
			folder: "orders",
			important: false,
		});
		expect(find(second.id)).toMatchObject({
			folder: "updates",
			important: true,
		});

		await moveTo(db, second.id, null);
		await setImportant(db, second.id, null);
		expect(
			(await db.select().from(marketEmails)).find((e) => e.id === second.id),
		).toMatchObject({ folder: "orders", important: false, relabelledAt: null });
		expect(await resort(db)).toEqual({ moved: 0, marked: 0 });
	});
});

describe("how far a sweep reads back", () => {
	const now = Date.UTC(2026, 9, 22);
	const day = 86_400_000;
	test("three days, or from a day before the last clean sweep, at most a month", () => {
		const kept = new Date(now);
		expect(sweepSince(now, null, null)).toEqual(new Date(now - 30 * day));
		expect(sweepSince(now, kept, null)).toEqual(new Date(now - 3 * day));
		expect(sweepSince(now, kept, new Date(now - day / 4))).toEqual(
			new Date(now - 3 * day),
		);
		// Down four days: reads back past the outage.
		expect(sweepSince(now, kept, new Date(now - 4 * day))).toEqual(
			new Date(now - 5 * day),
		);
		expect(sweepSince(now, kept, new Date(now - 90 * day))).toEqual(
			new Date(now - 30 * day),
		);
	});
});
