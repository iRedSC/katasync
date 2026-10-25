import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keepShopifyEmails } from "#/channels/shopify/order-emails";
import type { Db } from "#/db/client";
import {
	buyerMessages,
	marketEmails,
	orderBuyerContacts,
	orders,
	stores,
} from "#/db/schema";
import { ingestMarketMail } from "#/inbox/market-mail";
import { createTestDb } from "#/test/db";
import { reply, settleReplies } from "./send";
import { startShopifyThread, threadShopifyMail } from "./shopify-mail";
import { threadAddress } from "./shopify-match";
import { threadsPage } from "./threads";

const BUYER = "pat@example.com";
const INBOX = "marketplaces@eastcoastdrywall.com";

let db: Db;
let n = 0;
beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv("MARKETPLACE_INBOX", INBOX);
	vi.stubEnv("CRON_SECRET", "test-cron-secret");
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "ecdt.myshopify.com");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "shpat_test");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const answers = (list: Response[]) => {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, body: init?.body && JSON.parse(String(init.body)) });
			const next = list.shift();
			if (!next) throw new Error(`Unexpected fetch ${url}`);
			return next;
		}),
	);
	return calls;
};
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

async function store() {
	const [s] = await db
		.insert(stores)
		.values({ channel: "shopify", name: "ECDT" })
		.returning();
	if (!s) throw new Error("no store");
	return s;
}

// An order, with its buyer's email unless that's null.
async function order(
	storeId: number,
	over: Partial<typeof orders.$inferInsert> = {},
	buyerEmail: string | null = BUYER,
) {
	n++;
	const [o] = await db
		.insert(orders)
		.values({
			storeId,
			externalId: `gid://shopify/Order/${n}`,
			name: `#55${n}0`,
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 40,
			sourceUpdatedAt: new Date(),
			customerName: "Pat Doe",
			...over,
		})
		.returning();
	if (!o) throw new Error("no order");
	if (buyerEmail)
		await db
			.insert(orderBuyerContacts)
			.values({ orderId: o.id, email: buyerEmail });
	return o;
}

async function email(over: Partial<typeof marketEmails.$inferInsert> = {}) {
	n++;
	const [row] = await db
		.insert(marketEmails)
		.values({
			messageId: `<b${n}@example.com>`,
			market: null,
			folder: "updates",
			fromAddress: BUYER,
			senderAuthenticated: true,
			recipients: [INBOX],
			subject: "Re: Your order",
			body: "Thanks!",
			receivedAt: new Date(Date.now() + n * 1000),
			...over,
		})
		.returning();
	if (!row) throw new Error("not kept");
	return row;
}

describe("buyers' addresses", () => {
	test("the query tool's role can't read them", async () => {
		const { rows } = (await db.execute(
			sql`select has_table_privilege('katasync_mcp', 'order_buyer_contacts', 'select') as can`,
		)) as unknown as { rows: { can: boolean }[] };
		expect(rows).toEqual([{ can: false }]);
	});
});

describe("relayed TikTok orders", () => {
	test("are never asked for an email or given one", async () => {
		const s = await store();
		const own = await order(s.id, {}, null);
		const relayed = await order(
			s.id,
			{ marketplaceOrderId: "tiktok:576" },
			null,
		);
		const calls = answers([
			json(200, {
				data: {
					nodes: [
						{ id: own.externalId, email: " Pat@Example.com " },
						// Even should Shopify answer for it.
						{ id: relayed.externalId, email: "tiktok@scs.tiktokw.us" },
					],
				},
			}),
		]);
		await keepShopifyEmails(db, s.id, [
			{ id: own.externalId, tags: [] },
			{ id: relayed.externalId, tags: ["TikTokOrderID:576"] },
		]);
		expect(calls[0]?.body).toMatchObject({
			variables: { ids: [own.externalId] },
		});
		const kept = await db
			.select({
				orderId: orderBuyerContacts.orderId,
				email: orderBuyerContacts.email,
			})
			.from(orderBuyerContacts);
		expect(kept).toEqual([{ orderId: own.id, email: BUYER }]);
		await expect(startShopifyThread(db, relayed.id)).rejects.toThrow(
			"answered on its marketplace",
		);
	});

	test("Shopify refusing to say leaves orders syncing", async () => {
		const s = await store();
		const own = await order(s.id, {}, null);
		answers([
			json(200, { errors: [{ message: "Access denied for email field" }] }),
		]);
		expect(
			await keepShopifyEmails(db, s.id, [{ id: own.externalId, tags: [] }]),
		).toContain("Access denied");
	});
});

describe("emailing a Shopify buyer", () => {
	async function started() {
		const o = await order((await store()).id);
		const { threadId } = await startShopifyThread(db, o.id);
		return { o, threadId };
	}

	test("sends from the marketplaces mailbox, answered at the thread's address", async () => {
		const { o, threadId } = await started();
		const calls = answers([json(200, { id: "re_1" })]);
		const r = await reply(db, threadId, "It ships today.", crypto.randomUUID());
		expect(r.status).toBe("sent");
		expect(calls[0]?.body).toMatchObject({
			from: `East Coast Drywall Tools <${INBOX}>`,
			to: [BUYER],
			reply_to: threadAddress(threadId),
			subject: `Your order ${o.name}`,
		});

		answers([json(200, { last_event: "delivered" })]);
		await settleReplies(db);
		const [t] = await threadsPage(db, "open", "shopify");
		expect(t?.messages.at(-1)?.status).toBe("delivered");
	});

	test.each([
		[json(500, { message: "down" }), "sending"],
		[json(200, {}), "sending"],
		[json(422, { message: "Invalid `to`" }), "failed"],
	])("Resend answering %#: the reply is %s", async (res, status) => {
		const { threadId } = await started();
		answers([res]);
		const r = await reply(db, threadId, "Hi", crypto.randomUUID());
		expect(r.status).toBe(status);
	});

	test("a send that may have gone is never failed on a guess", async () => {
		const { threadId } = await started();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("socket hang up");
			}),
		);
		const r = await reply(db, threadId, "Hi", crypto.randomUUID());
		expect(r.status).toBe("sending");
	});

	test("their answer is filed on the thread and done in the mailbox", async () => {
		const { threadId } = await started();
		const answer = await email({
			recipients: [threadAddress(threadId) ?? ""],
			body: "Great, thanks!\n\nOn Mon someone wrote:\n> It ships today.",
		});
		const elsewhere = await email({ fromAddress: "sam@example.com" });
		expect(await threadShopifyMail(db)).toEqual({ filed: 1, unmatched: 0 });
		expect(await threadShopifyMail(db)).toEqual({ filed: 0, unmatched: 0 });
		const [kept] = await db
			.select()
			.from(buyerMessages)
			.where(eq(buyerMessages.marketEmailId, answer.id));
		expect(kept).toMatchObject({ threadId, body: "Great, thanks!" });
		const done = await db
			.select({ id: marketEmails.id, doneAt: marketEmails.doneAt })
			.from(marketEmails)
			.orderBy(marketEmails.id);
		expect(done.find((e) => e.id === answer.id)?.doneAt).not.toBeNull();
		expect(done.find((e) => e.id === elsewhere.id)?.doneAt).toBeNull();
	});

	test("an answer between two open threads stays in the mailbox", async () => {
		const s = await store();
		for (const o of [await order(s.id), await order(s.id)])
			await startShopifyThread(db, o.id);
		const unsure = await email({ subject: "Question" });
		expect(await threadShopifyMail(db)).toEqual({ filed: 0, unmatched: 1 });
		const [row] = await db
			.select({ doneAt: marketEmails.doneAt })
			.from(marketEmails)
			.where(eq(marketEmails.id, unsure.id));
		expect(row?.doneAt).toBeNull();
	});

	test("a forged From is never filed as the buyer's", async () => {
		const { threadId } = await started();
		const forged = await email({
			senderAuthenticated: false,
			recipients: [threadAddress(threadId) ?? ""],
		});
		expect(await threadShopifyMail(db)).toEqual({ filed: 0, unmatched: 1 });
		const kept = await db
			.select()
			.from(buyerMessages)
			.where(eq(buyerMessages.marketEmailId, forged.id));
		expect(kept).toEqual([]);
	});

	test("the mailbox keeps whether Microsoft vouched for a buyer's sender", async () => {
		const message = (from: string) => {
			n++;
			return {
				graphId: `g${n}`,
				messageId: `<i${n}@mail>`,
				receivedAt: new Date(),
				subject: "Re: Your order",
				fromAddress: from,
				fromName: null,
				recipients: [INBOX],
			};
		};
		const vouched = message(BUYER);
		const forged = message("sam@example.com");
		await ingestMarketMail(
			db,
			[vouched, forged],
			async () => ({ body: "Hi", attachments: [] }),
			async (id) => [
				{
					name: "Authentication-Results",
					value:
						id === vouched.graphId
							? "dmarc=pass header.from=example.com;compauth=pass reason=100"
							: "dmarc=fail header.from=example.com;compauth=fail reason=000",
				},
			],
		);
		const rows = await db
			.select({
				from: marketEmails.fromAddress,
				ok: marketEmails.senderAuthenticated,
			})
			.from(marketEmails)
			.orderBy(marketEmails.id);
		expect(rows).toEqual([
			{ from: BUYER, ok: true },
			{ from: "sam@example.com", ok: false },
		]);
	});
});
