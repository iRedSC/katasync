import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { marketEmails } from "#/db/schema";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import { createTestDb } from "#/test/db";
import {
	countAttention,
	ingestMarketMail,
	labelOf,
	marketMailPage,
	marketOf,
	readMarketMail,
	relabel,
	resort,
	setDone,
} from "./market-mail";

describe("sorting", () => {
	test("by sender", () => {
		expect(marketOf("seller-notification@amazon.com")).toBe("amazon");
		expect(marketOf("donotreply@marketplace.amazon.com")).toBe("amazon");
		expect(marketOf("ebay@ebay.com")).toBe("ebay");
		expect(marketOf("noreply@seller-us.tiktokshop.com")).toBe("tiktok");
		expect(marketOf("mailer@shopify.com")).toBe("shopify");
		// Lookalikes aren't the marketplace.
		expect(marketOf("deals@notamazon.com")).toBeNull();
		expect(marketOf("someone@gmail.com")).toBeNull();
	});

	test("by subject: what needs someone before the day-to-day", () => {
		expect(labelOf("Policy Warning: Listing removed")).toBe("attention");
		expect(labelOf("Your Amazon.com listing has been suppressed")).toBe(
			"attention",
		);
		expect(labelOf("A buyer opened a dispute on order 123")).toBe("attention");
		expect(labelOf("Action required: verify your identity")).toBe("attention");
		expect(labelOf("Activate Your Account as Shop User")).toBe("attention");
		expect(labelOf("Sold, ship now: Drywall Banjo")).toBe("orders");
		expect(labelOf("You made a sale!")).toBe("orders");
		expect(labelOf("Order 112-3 has been cancelled")).toBe("orders");
		expect(labelOf("Refund Initiated for Order 111-2762240")).toBe("returns");
		expect(labelOf("Return request for Drywall Banjo")).toBe("returns");
		// A return that turned into a claim needs someone.
		expect(labelOf("A-to-z claim on your return")).toBe("attention");
		expect(labelOf("Your payout is on its way")).toBe("updates");
		expect(labelOf("New features for sellers")).toBe("updates");
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

		const page = await marketMailPage(db, "attention", null);
		expect(page.counts).toEqual({
			attention: 1,
			orders: 1,
			returns: 0,
			updates: 0,
		});
		expect(page.emails).toEqual([
			expect.objectContaining({
				market: "amazon",
				subject: "Policy warning on your listing",
				body: "Details",
				attachments: [
					expect.objectContaining({ filename: "report.csv", kept: true }),
				],
			}),
		]);
		expect(await countAttention(db)).toBe(1);
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
			await marketMailPage(db, "attention", null)
		).emails.sort((a, b) => a.id - b.id);
		await setDone(db, amazon.id, true);
		await relabel(db, tiktok.id, "orders");

		expect((await marketMailPage(db, "attention", null)).emails).toEqual([]);
		expect(
			(await marketMailPage(db, "done", null)).emails.map((e) => e.id),
		).toEqual([amazon.id]);
		const tiktokOrders = await marketMailPage(db, "orders", "tiktok");
		expect(tiktokOrders.emails.map((e) => e.id)).toEqual([tiktok.id]);
		expect((await marketMailPage(db, "orders", "amazon")).emails).toEqual([]);

		await setDone(db, amazon.id, false);
		expect(
			(await marketMailPage(db, "attention", "amazon")).counts.attention,
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
		const page = await marketMailPage(db, "attention", null);
		expect(page.connected).toBe(true);
		expect(page.check?.error).toContain("Access is denied");
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

describe("re-sorting", () => {
	test("mail sorted by older rules moves; mail staff moved stays", async () => {
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
		// As if both came in before Returns existed, and staff then moved one.
		await db.update(marketEmails).set({ label: "orders" });
		await relabel(db, second.id, "updates");

		expect(await resort(db)).toBe(1);
		const after = await db.select().from(marketEmails);
		expect(after.find((e) => e.id === first.id)?.label).toBe("returns");
		expect(after.find((e) => e.id === second.id)?.label).toBe("updates");
	});
});
