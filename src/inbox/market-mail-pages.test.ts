import { describe, expect, test } from "vitest";
import { marketEmails } from "#/db/schema";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import { createTestDb } from "#/test/db";
import { ingestMarketMail, marketMailPage } from "./market-mail";

// A minute apart, so the newest is the last.
const message = (i: number): InboxMessage => ({
	graphId: `g${i}`,
	messageId: `<${i}@mail>`,
	receivedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
	subject: `Listing note ${i}`,
	fromAddress: "seller@amazon.com",
	fromName: null,
	recipients: ["marketplaces@eastcoastdrywall.com"],
});
const read = async () => ({ body: "Details", attachments: [] });

describe("paging the mailbox", () => {
	test("the 151st email is reachable without moving any newer one", async () => {
		const db = await createTestDb();
		await ingestMarketMail(
			db,
			Array.from({ length: 151 }, (_, i) => message(i)),
			read,
		);
		const first = await marketMailPage(db, "updates", null);
		expect(first.emails).toHaveLength(150);
		expect(first.next).not.toBeNull();
		const rest = await marketMailPage(db, "updates", null, {
			after: first.next ?? undefined,
		});
		expect(rest.emails.map((e) => e.subject)).toEqual(["Listing note 0"]);
		expect(rest.next).toBeNull();
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
		const result = await ingestMarketMail(db, [message(0)], broken);
		expect(result).toEqual({ read: 0, problems: [expect.any(String)] });
		expect(await db.select().from(marketEmails)).toEqual([]);
	});
});
