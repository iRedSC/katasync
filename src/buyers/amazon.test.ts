import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import { buyerMessages, marketEmails, orders, stores } from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	applyAmazonRefusals,
	parseCopy,
	parseRelayed,
	threadAmazonMail,
} from "./amazon-mail";
import { addReplyFile } from "./reply-files";
import { reply, settleReplies } from "./send";
import { settleReply } from "./states";
import { logOurs, threadsPage, waitingOn } from "./threads";

const RELAY =
	"p39fytvw2631s9q+f12f0666-7d6a-49b0-b2d2-a35f46ae7784@marketplace.amazon.com";

// Amazon's layout, as it arrived on 2026-10-22, cut short.
const BODY = `[Amazon.com]<https://sellercentral.amazon.com/nms/redirect/x>\r
\r
You have received a message.\r
\r
Order ID: 113-1228890-8225003:\r
\r
#       ASIN    Product Name\r
1       B099PYB4MX      CanAm Tool GoldCor Finishing Coat Inside Corner Applicator\r
Message:\r
\r
The shipping box and packing receipt was dropped off. The drywall tool was not inside the box.\r
\r
If there anyway that I could get another shipped to me?\r
\r
View Message <https://sellercentral.amazon.com/nms/sellermobile/redirect/y>     Resolve Case <https://z>\r
\r
This service is provided solely for communication with buyers.`;

const SUBJECT =
	"Inquiry from Amazon customer Rick (Order: 113-1228890-8225003)";

let db: Db;
let n = 0;
beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv("MARKETPLACE_INBOX", "marketplaces@eastcoastdrywall.com");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function email(over: Partial<typeof marketEmails.$inferInsert> = {}) {
	n++;
	const [row] = await db
		.insert(marketEmails)
		.values({
			messageId: `<m${n}@amazon>`,
			market: "amazon",
			folder: "orders",
			fromAddress: RELAY,
			// Microsoft vouched it came from Amazon (./amazon-auth.test.ts).
			senderAuthenticated: true,
			recipients: ["marketplaces@eastcoastdrywall.com"],
			subject: SUBJECT,
			body: BODY,
			receivedAt: new Date(Date.UTC(2026, 9, 22, 16, n)),
			...over,
		})
		.returning();
	if (!row) throw new Error("not kept");
	return row;
}

const resend = (answers: Response[]) => {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			const next = answers.shift();
			if (!next) throw new Error(`Unexpected fetch ${url}`);
			return next;
		}),
	);
	return calls;
};
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

describe("Amazon's relayed emails", () => {
	test("reads the buyer, the order, and only their words", () => {
		expect(parseRelayed({ subject: SUBJECT, body: BODY })).toEqual({
			buyerName: "Rick",
			orderRef: "113-1228890-8225003",
			text: "The shipping box and packing receipt was dropped off. The drywall tool was not inside the box.\n\nIf there anyway that I could get another shipped to me?",
		});
	});

	test("an unknown layout keeps the whole body", () => {
		expect(
			parseRelayed({ subject: "Hello", body: "Where is my order?" }).text,
		).toBe("Where is my order?");
	});

	test("each email is one message, once, on the buyer's thread with its order", async () => {
		const [store] = await db
			.insert(stores)
			.values({ channel: "amazon", name: "Amazon" })
			.returning();
		const [order] = await db
			.insert(orders)
			.values({
				storeId: store?.id ?? 0,
				externalId: "113-1228890-8225003",
				name: "113-1228890-8225003",
				placedAt: new Date(),
				fulfillmentStatus: "Shipped",
				total: 40,
				sourceUpdatedAt: new Date(),
			})
			.returning();
		await email();
		expect(await threadAmazonMail(db)).toBe(1);
		expect(await threadAmazonMail(db)).toBe(0);
		await email({ subject: `RE: ${SUBJECT}`, body: "Hello?" });
		await email({ fromAddress: "seller-notification@amazon.com" });
		expect(await threadAmazonMail(db)).toBe(1);

		const [thread, ...others] = await threadsPage(db, "open", null);
		expect(others).toEqual([]);
		expect(thread).toMatchObject({
			market: "amazon",
			buyerName: "Rick",
			orderId: order?.id,
			waiting: {
				since: new Date(Date.UTC(2026, 9, 22, 16, n - 2)),
				due: new Date(Date.UTC(2026, 9, 23, 16, n - 2)),
			},
		});
		expect(thread?.messages.map((m) => m.body.slice(0, 12))).toEqual([
			"The shipping",
			"Hello?",
		]);
	});
});

describe("answering", () => {
	test("waits on us until a reply that didn't fail", () => {
		const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
		const theirs = { fromBuyer: true, status: null };
		expect(
			waitingOn("amazon", [
				{ ...theirs, at: at(1) },
				{ fromBuyer: false, status: "failed", at: at(2) },
				{ ...theirs, at: at(3) },
			])?.since,
		).toEqual(at(1));
		expect(
			waitingOn("amazon", [
				{ ...theirs, at: at(1) },
				{ fromBuyer: false, status: "sending", at: at(2) },
			]),
		).toBeNull();
	});

	test("a reply goes to the buyer's address, then settles delivered", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		const calls = resend([json(200, { id: "re_1" })]);
		const r = await reply(
			db,
			thread?.id ?? 0,
			"  Sending another today.  ",
			crypto.randomUUID(),
		);
		expect(r.status).toBe("sent");
		const sent = JSON.parse(String(calls[0]?.init?.body));
		expect(sent).toMatchObject({
			from: "marketplaces@eastcoastdrywall.com",
			to: [RELAY],
			subject: `Re: ${SUBJECT}`,
			text: "Sending another today.",
			headers: { "In-Reply-To": `<m${n}@amazon>` },
		});

		resend([json(200, { last_event: "delivered" })]);
		await settleReplies(db);
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages.at(-1)?.status).toBe("delivered");
		expect(after?.waiting).toBeNull();
	});

	test("files go with the email, and only kinds Amazon takes", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		const pdf = await addReplyFile(db, {
			filename: "label.pdf",
			contentType: "application/pdf",
			data: new TextEncoder().encode("%PDF-1"),
		});
		const word = await addReplyFile(db, {
			filename: "note.doc",
			contentType: "application/msword",
			data: new Uint8Array([1]),
		});
		await expect(
			reply(db, thread?.id ?? 0, "", crypto.randomUUID(), [word.id]),
		).rejects.toThrow(/Takes PDF, JPG, PNG/);
		const calls = resend([json(200, { id: "re_2" })]);
		const r = await reply(db, thread?.id ?? 0, "", crypto.randomUUID(), [
			pdf.id,
		]);
		expect(r.status).toBe("sent");
		expect(JSON.parse(String(calls[0]?.init?.body)).attachments).toEqual([
			{
				filename: "label.pdf",
				content: Buffer.from("%PDF-1").toString("base64"),
			},
		]);
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages.at(-1)?.media).toEqual([
			{
				kind: "PDF",
				name: "label.pdf",
				url: `/api/buyer-files/${pdf.id}`,
				fileId: pdf.id,
			},
		]);
	});

	test("an unsure send is tried again with the same key; a refused one fails", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		const calls = resend([json(500, { message: "down" })]);
		expect(
			(await reply(db, thread?.id ?? 0, "One", crypto.randomUUID())).status,
		).toBe("sending");

		const retry = resend([json(200, { id: "re_2" })]);
		// Not while the first request may still be going.
		await settleReplies(db);
		expect(retry).toEqual([]);
		await settleReplies(db, Date.now() + 120_000);
		const key = (c: (typeof calls)[number] | undefined) =>
			new Headers(c?.init?.headers).get("Idempotency-Key");
		expect(key(retry[0])).toBe(key(calls[0]));
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages.at(-1)?.status).toBe("sent");

		resend([json(422, { message: "Invalid `to` field" })]);
		const r = await reply(db, thread?.id ?? 0, "Two", crypto.randomUUID());
		expect(r.status).toBe("failed");
		const [last] =
			(await threadsPage(db, "open", null))[0]?.messages.slice(-1) ?? [];
		expect(last?.error).toBe("Resend answered 422: Invalid `to` field");
	});

	test("Amazon refusing a delivered reply fails it; a package notice doesn't", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		resend([json(200, { id: "re_3" })]);
		const r = await reply(db, thread?.id ?? 0, "Hi", crypto.randomUUID());
		await settleReply(db, r.id, { kind: "delivered" });
		const later = new Date(Date.now() + 60_000);
		await email({
			fromAddress: "seller-notification@amazon.com",
			subject: "Package could not be delivered",
			body: `Order 113-1228890-8225003`,
			receivedAt: later,
		});
		expect(await applyAmazonRefusals(db)).toBe(0);
		// Vouched for, but from a domain that only starts with Amazon's.
		await email({
			fromAddress: "seller-notification@amazon.com.attacker.com",
			subject: "Your message could not be delivered",
			body: `To ${RELAY}`,
			receivedAt: later,
		});
		expect(await applyAmazonRefusals(db)).toBe(0);
		await email({
			fromAddress: "seller-notification@amazon.com",
			subject: "Your message could not be delivered",
			body: `To ${RELAY}`,
			receivedAt: later,
		});
		expect(await applyAmazonRefusals(db)).toBe(1);
		expect(await applyAmazonRefusals(db)).toBe(0);
	});

	test("a notice fails one reply, once; with two out it can't tell which", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		const id = thread?.id ?? 0;
		const later = new Date(Date.now() + 60_000);
		const notice = () =>
			email({
				fromAddress: "seller-notification@amazon.com",
				subject: "Your message could not be delivered",
				body: `To ${RELAY}`,
				receivedAt: later,
			});
		resend([json(200, { id: "re_a" }), json(200, { id: "re_b" })]);
		const a = await reply(db, id, "A", crypto.randomUUID());
		await notice();
		expect(await applyAmazonRefusals(db)).toBe(1);
		const b = await reply(db, id, "B", crypto.randomUUID());
		await settleReply(db, b.id, { kind: "delivered" });
		// The used notice doesn't go on to the next reply.
		expect(await applyAmazonRefusals(db)).toBe(0);
		resend([json(200, { id: "re_c" })]);
		const c = await reply(db, id, "C", crypto.randomUUID());
		await notice();
		// B and C are both out: which one it's about is a guess, so neither.
		expect(await applyAmazonRefusals(db)).toBe(0);
		const statuses = (await threadsPage(db, "open", null))[0]?.messages
			.filter((m) => !m.fromBuyer)
			.map((m) => [m.id, m.status]);
		expect(statuses).toEqual([
			[a.id, "failed"],
			[b.id, "delivered"],
			[c.id, "sent"],
		]);
	});

	test("Resend's events: suppressed never went; an unknown one is reported", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		resend([json(200, { id: "re_s" }), json(200, { id: "re_u" })]);
		await reply(db, thread?.id ?? 0, "One", crypto.randomUUID());
		await reply(db, thread?.id ?? 0, "Two", crypto.randomUUID());
		resend([
			json(200, { last_event: "suppressed" }),
			json(200, { last_event: "teleported" }),
		]);
		const r = await settleReplies(db);
		expect(r.problems).toEqual(["Resend says teleported of reply re_u"]);
		const statuses = (await threadsPage(db, "open", null))[0]?.messages
			.filter((m) => !m.fromBuyer)
			.map((m) => m.status);
		expect(statuses).toEqual(["failed", "sent"]);
	});

	test("an answer that doesn't read leaves it sending, and every try is the same email", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		const first = resend([
			new Response("<html>gateway</html>", { status: 200 }),
		]);
		expect(
			(await reply(db, thread?.id ?? 0, "Hi", crypto.randomUUID())).status,
		).toBe("sending");
		// The buyer writes again before the retry.
		await email({ body: "Hello?" });
		await threadAmazonMail(db);
		const retry = resend([json(200, { id: "re_r" })]);
		await settleReplies(db, Date.now() + 120_000);
		expect(retry[0]?.init?.body).toBe(first[0]?.init?.body);
	});

	test("a day without an answer is unconfirmed, not failed", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		resend([json(503, {})]);
		await reply(db, thread?.id ?? 0, "Hi", crypto.randomUUID());
		resend([]);
		await settleReplies(db, Date.now() + 24 * 3_600_000);
		const [after] = await threadsPage(db, "open", null);
		expect(after?.messages.at(-1)).toMatchObject({
			status: "unconfirmed",
			error: expect.stringMatching(/Seller Central/),
		});
		// It may not have gone, so the buyer still waits on us.
		expect(after?.waiting).not.toBeNull();
	});

	test("a status moves only from where its event follows", async () => {
		await email();
		await threadAmazonMail(db);
		const [thread] = await threadsPage(db, "open", null);
		resend([json(200, { id: "re_4" })]);
		const r = await reply(db, thread?.id ?? 0, "Hi", crypto.randomUUID());
		expect(await settleReply(db, r.id, { kind: "delivered" })).toBe(true);
		// Late and repeated events change nothing.
		expect(
			await settleReply(db, r.id, { kind: "accepted", externalId: "x" }),
		).toBe(false);
		expect(
			await settleReply(db, r.id, { kind: "unconfirmed", error: "not found" }),
		).toBe(false);
		// The database refuses a reply marked gone with no ID.
		await expect(
			db.insert(buyerMessages).values({
				threadId: thread?.id ?? 0,
				fromBuyer: false,
				body: "x",
				at: new Date(),
				status: "delivered",
				requestKey: crypto.randomUUID(),
				statusAt: new Date(),
			}),
		).rejects.toThrow();
	});
});

// Amazon's copy of one sent in Seller Central, as it arrived on 2026-10-22.
const COPY = `Dear East Coast Drywall Tools,\r
\r
Here is a copy of the e-mail that you sent to Rick.\r
\r
Order ID: 113-1228890-8225003:\r
\r
#       ASIN    Product Name\r
1       B099PYB4MX      CanAm Tool GoldCor Finishing Coat Inside Corner Applicator\r
\r
------------- Begin message -------------\r
\r
I believe the proper way to do this is to have Amazon refund the order.\r
\r
------------- End message -------------\r
\r
Warmest Regards,`;
const COPIED =
	"I believe the proper way to do this is to have Amazon refund the order.";
const copy = () =>
	email({
		fromAddress: "donotreply@amazon.com",
		subject: "Your e-mail to Rick",
		body: COPY,
	});
const bodies = async () =>
	(await threadsPage(db, "open", null))[0]?.messages.map((m) => [
		m.body.slice(0, 12),
		m.fromBuyer,
	]);

describe("sent in Seller Central", () => {
	// Just after the copy arrived, so it's read as recent and words added
	// by hand now are near it.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 22, 18) });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("reads the order and only our words", () => {
		expect(parseCopy({ subject: "Your e-mail to Rick", body: COPY })).toEqual({
			orderRef: "113-1228890-8225003",
			text: COPIED,
		});
		expect(parseCopy({ subject: SUBJECT, body: BODY })).toBeNull();
	});

	test("Amazon's copy goes on the order's thread as ours, once, answering it", async () => {
		await email();
		await threadAmazonMail(db);
		await copy();
		expect(await threadAmazonMail(db)).toBe(1);
		expect(await threadAmazonMail(db)).toBe(0);
		expect(await bodies()).toEqual([
			["The shipping", true],
			["I believe th", false],
		]);
		expect((await threadsPage(db, "open", null))[0]?.waiting).toBeNull();
	});

	test("it takes the place of the same words added without sending", async () => {
		await email();
		await threadAmazonMail(db);
		const [t] = await threadsPage(db, "open", null);
		await logOurs(db, t?.id ?? 0, COPIED, crypto.randomUUID());
		await copy();
		await threadAmazonMail(db);
		expect(await bodies()).toEqual([
			["The shipping", true],
			["I believe th", false],
		]);
		const [ours] =
			(await threadsPage(db, "open", null))[0]?.messages.slice(1) ?? [];
		expect(ours?.logged).toBe(false);
	});

	test("one sent from here isn't doubled by a copy of it", async () => {
		await email();
		await threadAmazonMail(db);
		const [t] = await threadsPage(db, "open", null);
		await db.insert(buyerMessages).values({
			threadId: t?.id ?? 0,
			fromBuyer: false,
			body: COPIED,
			externalId: "resend-1",
			at: new Date(Date.UTC(2026, 9, 22, 17)),
			status: "delivered",
			requestKey: crypto.randomUUID(),
			statusAt: new Date(),
		});
		await copy();
		expect(await threadAmazonMail(db)).toBe(0);
		expect(await bodies()).toHaveLength(2);
	});

	test("a copy for an order with no thread waits for one", async () => {
		await copy();
		expect(await threadAmazonMail(db)).toBe(0);
		await email();
		expect(await threadAmazonMail(db)).toBe(2);
	});
});
