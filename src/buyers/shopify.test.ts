import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keepShopifyEmails } from "#/channels/shopify/order-emails";
import type { Db } from "#/db/client";
import { buyerMessages, marketEmails, orders, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import { reply, settleReplies } from "./send";
import {
	matchShopifyReply,
	replyText,
	type ShopifyThreadRef,
	startShopifyThread,
	threadAddress,
	threadShopifyMail,
} from "./shopify-mail";
import { threadsPage } from "./threads";

const BUYER = "pat@example.com";
const INBOX = "marketplaces@eastcoastdrywall.com";

let db: Db;
let n = 0;
beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv("MARKETPLACE_INBOX", INBOX);
	vi.stubEnv("SHOPIFY_EMAIL_FROM", "East Coast Drywall Tools <sales@ecdt.com>");
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

async function order(
	storeId: number,
	over: Partial<typeof orders.$inferInsert> = {},
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
			buyerEmail: BUYER,
			...over,
		})
		.returning();
	if (!o) throw new Error("no order");
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

describe("matching a buyer's email to a thread", () => {
	const at = new Date(Date.UTC(2026, 9, 1));
	const thread = (id: number, orderName: string, open = true) =>
		({
			id,
			email: BUYER,
			orderName,
			open,
			createdAt: at,
		}) satisfies ShopifyThreadRef;
	const mail = (over: Partial<Parameters<typeof matchShopifyReply>[0]>) => ({
		fromAddress: BUYER,
		recipients: [INBOX],
		subject: "Hello",
		body: "",
		receivedAt: new Date(Date.UTC(2026, 9, 2)),
		...over,
	});
	const two = [thread(1, "#5536"), thread(2, "#5537")];

	test("its thread address wins over the order it names", () => {
		expect(
			matchShopifyReply(
				mail({ recipients: [threadAddress(2) ?? ""], subject: "Re: #5536" }),
				two,
			),
		).toEqual({ threadId: 2, by: "address" });
	});

	test("another buyer's thread address is left unmatched", () => {
		const theirs = { ...thread(3, "#5538"), email: "sam@example.com" };
		expect(
			matchShopifyReply(mail({ recipients: [threadAddress(3) ?? ""] }), [
				...two,
				theirs,
			]).threadId,
		).toBeNull();
	});

	test("falls back to the one order it names, never a longer number", () => {
		expect(
			matchShopifyReply(mail({ subject: "Re: Your order #5537" }), two),
		).toEqual({ threadId: 2, by: "order" });
		expect(
			matchShopifyReply(mail({ subject: "Re: Your order #55370" }), two)
				.threadId,
		).toBeNull();
	});

	test("two of their orders named, or two open threads, is left unmatched", () => {
		expect(
			matchShopifyReply(mail({ body: "About #5536 and #5537" }), two),
		).toMatchObject({ threadId: null });
		expect(matchShopifyReply(mail({}), two)).toMatchObject({ threadId: null });
	});

	test("their one open thread takes what names nothing", () => {
		expect(
			matchShopifyReply(mail({}), [
				thread(1, "#5536"),
				thread(2, "#5537", false),
			]),
		).toEqual({ threadId: 1, by: "sender" });
	});

	test("mail from before the thread, or from someone else, isn't an answer", () => {
		const one = [thread(1, "#5536")];
		expect(
			matchShopifyReply(
				mail({ receivedAt: new Date(Date.UTC(2026, 8, 1)) }),
				one,
			).threadId,
		).toBeNull();
		expect(
			matchShopifyReply(mail({ fromAddress: "sam@example.com" }), one).threadId,
		).toBeNull();
	});

	test("keeps their words above the quoted email", () => {
		expect(
			replyText(
				"Yes please.\r\n\r\nOn Mon, Oct 5, 2026 at 9:00 AM ECDT <sales@ecdt.com> wrote:\r\n> Your order",
			),
		).toBe("Yes please.");
		expect(replyText("Just this")).toBe("Just this");
	});
});

describe("relayed TikTok orders", () => {
	test("are never asked for an email or given one", async () => {
		const s = await store();
		const own = await order(s.id, { buyerEmail: null });
		const relayed = await order(s.id, {
			buyerEmail: null,
			marketplaceOrderId: "tiktok:576",
		});
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
			.select({ id: orders.id, email: orders.buyerEmail })
			.from(orders)
			.orderBy(orders.id);
		expect(kept).toEqual([
			{ id: own.id, email: BUYER },
			{ id: relayed.id, email: null },
		]);
		await expect(startShopifyThread(db, relayed.id)).rejects.toThrow(
			"answered on its marketplace",
		);
	});

	test("Shopify refusing to say leaves orders syncing", async () => {
		const s = await store();
		const own = await order(s.id, { buyerEmail: null });
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

	test("sends from the store, answered at the thread's address", async () => {
		const { o, threadId } = await started();
		const calls = answers([json(200, { id: "re_1" })]);
		const r = await reply(db, threadId, "It ships today.", crypto.randomUUID());
		expect(r.status).toBe("sent");
		expect(calls[0]?.body).toMatchObject({
			from: "East Coast Drywall Tools <sales@ecdt.com>",
			to: [BUYER],
			reply_to: `marketplaces+so${threadId}@eastcoastdrywall.com`,
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
			recipients: [`marketplaces+so${threadId}@eastcoastdrywall.com`],
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
});
