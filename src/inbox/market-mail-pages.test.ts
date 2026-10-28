import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { marketEmails } from "#/db/schema";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import { createTestDb } from "#/test/db";
import { ingestMarketMail, marketMailPage } from "./market-mail";

// All at one moment, so only the id tells them apart.
const at = new Date(Date.UTC(2026, 9, 1, 0, 0));
const message = (i: number): InboxMessage => ({
	graphId: `g${i}`,
	messageId: `<${i}@mail>`,
	receivedAt: at,
	subject: `Listing note ${i}`,
	fromAddress: "seller@amazon.com",
	fromName: null,
	recipients: ["marketplaces@eastcoastdrywall.com"],
});
const read = async () => ({ body: "Details", attachments: [] });

describe("paging the mailbox", () => {
	test("emails at the same moment across a page boundary each show once, in order", async () => {
		const db = await createTestDb();
		await ingestMarketMail(db, [0, 1, 2].map(message), read, async () => []);
		// Marked done and back rewrites the oldest's row, so the index no longer
		// lists equal times in arrival order.
		const oldest = eq(marketEmails.subject, "Listing note 0");
		await db.update(marketEmails).set({ doneAt: at }).where(oldest);
		await db.update(marketEmails).set({ doneAt: null }).where(oldest);
		const first = await marketMailPage(db, "updates", null, { limit: 2 });
		expect(first.emails).toHaveLength(2);
		expect(first.next).not.toBeNull();
		const rest = await marketMailPage(db, "updates", null, {
			limit: 2,
			after: first.next ?? undefined,
		});
		expect(rest.emails.map((e) => e.subject)).toEqual(["Listing note 0"]);
		expect(rest.next).toBeNull();
		expect([...first.emails, ...rest.emails].map((e) => e.subject)).toEqual([
			"Listing note 2",
			"Listing note 1",
			"Listing note 0",
		]);
	}, 30_000);

	test("an email whose files fail to save is not counted", async () => {
		const db = await createTestDb();
		const broken = async () => ({
			body: "Details",
			// Not a size the database takes, so the whole email rolls back.
			attachments: [
				{
					filename: "a.txt",
					contentType: "text/plain",
					size: Number.NaN,
					data: Buffer.from("a"),
				},
			],
		});
		const result = await ingestMarketMail(
			db,
			[message(0)],
			broken,
			async () => [],
		);
		expect(result).toEqual({ read: 0, problems: [expect.any(String)] });
		expect(await db.select().from(marketEmails)).toEqual([]);
	});
});
