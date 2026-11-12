import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import {
	buyerMessages,
	buyerThreads,
	marketEmails,
	orders,
	stores,
} from "#/db/schema";
import { createTestDb } from "#/test/db";
import { parseCopy, parseRelayed, threadAmazonMail } from "./amazon-mail";
import {
	clearWaiting,
	countWaiting,
	countWaitingByMarket,
	ensureThread,
	recordFromBuyer,
	setThreadDone,
	unclearThreads,
} from "./threads";

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

// Every message kept, oldest first: the start of its words, and whether the
// buyer wrote it.
const bodies = async () =>
	(
		await db
			.select()
			.from(buyerMessages)
			.orderBy(buyerMessages.at, buyerMessages.id)
	).map((m) => [m.body.slice(0, 12), m.fromBuyer]);

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

		const [thread, ...others] = await db.select().from(buyerThreads);
		expect(others).toEqual([]);
		expect(thread).toMatchObject({
			market: "amazon",
			buyerName: "Rick",
			orderRef: order?.externalId,
		});
		expect(await bodies()).toEqual([
			["The shipping", true],
			["Hello?", true],
		]);
		expect(await countWaiting(db, "amazon")).toBe(1);
	});
});

describe("waiting on us", () => {
	test("until a reply that answers: not one that failed or may not have gone", async () => {
		const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
		const statuses = [
			null,
			"failed",
			"sending",
			"sent",
			"unconfirmed",
			"delivered",
		] as const;
		// Each reply state, after the buyer and before them; and at the same
		// moment as the buyer's, where the order they're kept in decides.
		let k = 0;
		for (const market of ["amazon", "ebay"] as const)
			for (const status of statuses)
				for (const ours of [2, 0, 1]) {
					k++;
					const t = await ensureThread(db, {
						market,
						externalId: `w${k}`,
						subject: "Waiting?",
					});
					await recordFromBuyer(db, t.id, {
						externalId: `w${k}-b`,
						body: "Hi",
						at: at(1),
					});
					if (status)
						await db.insert(buyerMessages).values({
							threadId: t.id,
							fromBuyer: false,
							body: "Hello",
							externalId: `w${k}-o`,
							at: at(ours || 1),
							status,
							requestKey: crypto.randomUUID(),
							statusAt: at(1),
							...(status === "failed" ? { error: "No" } : {}),
							...(status === "unconfirmed" ? { error: "Unsure" } : {}),
						});
					if (ours === 0)
						await recordFromBuyer(db, t.id, {
							externalId: `w${k}-b2`,
							body: "Hello?",
							at: at(3),
						});
				}
		const done = await ensureThread(db, {
			market: "amazon",
			externalId: "done",
			subject: "Done",
		});
		await recordFromBuyer(db, done.id, {
			externalId: "d",
			body: "Hi",
			at: at(1),
		});
		await setThreadDone(db, done.id, true);
		// Per market: no reply, a failed one, or an unconfirmed one wait in all
		// three places (9); an answering one only when the buyer wrote again
		// after it (3).
		expect(await countWaitingByMarket(db)).toEqual({
			amazon: 12,
			ebay: 12,
			tiktok: 0,
		});
		expect(await countWaiting(db, null)).toBe(24);
		expect(await countWaiting(db, "ebay")).toBe(12);
	});

	test("a new message from the buyer counts a done thread again", async () => {
		const t = await ensureThread(db, {
			market: "tiktok",
			externalId: "c1",
			subject: "Chat",
		});
		await recordFromBuyer(db, t.id, {
			externalId: "1",
			body: "Hi",
			at: new Date(),
		});
		await setThreadDone(db, t.id, true);
		expect(await countWaiting(db, "tiktok")).toBe(0);
		await recordFromBuyer(db, t.id, {
			externalId: "2",
			body: "Hello?",
			at: new Date(),
		});
		expect(await countWaiting(db, "tiktok")).toBe(1);
	});

	test("clearing a marketplace takes only its waiting threads, and undoes", async () => {
		const waiting = async (market: "ebay" | "tiktok", id: string) => {
			const t = await ensureThread(db, { market, externalId: id, subject: id });
			await recordFromBuyer(db, t.id, {
				externalId: id,
				body: "Thanks!",
				at: new Date(),
			});
			return t;
		};
		const a = await waiting("ebay", "e1");
		const b = await waiting("ebay", "e2");
		await waiting("tiktok", "t1");
		await setThreadDone(db, b.id, true);
		const cleared = await clearWaiting(db, "ebay");
		expect(cleared).toEqual([a.id]);
		expect(await countWaitingByMarket(db)).toEqual({
			amazon: 0,
			ebay: 0,
			tiktok: 1,
		});
		await unclearThreads(db, cleared);
		expect(await countWaiting(db, "ebay")).toBe(1);
	});

	test("Shopify's threads aren't counted: their buyers aren't read anymore", async () => {
		const t = await ensureThread(db, {
			market: "shopify",
			externalId: "o1",
			subject: "Your order",
		});
		await recordFromBuyer(db, t.id, {
			externalId: "1",
			body: "Hi",
			at: new Date(),
		});
		expect(await countWaiting(db, null)).toBe(0);
		expect(await countWaiting(db, "shopify")).toBe(0);
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
		expect(await countWaiting(db, "amazon")).toBe(0);
	});

	test("a copy for an order with no thread waits for one", async () => {
		await copy();
		expect(await threadAmazonMail(db)).toBe(0);
		await email();
		expect(await threadAmazonMail(db)).toBe(2);
	});
});
