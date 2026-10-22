import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import type { InboxMessage } from "#/purchasing/inbox/graph";
import { messageHtml } from "#/purchasing/inbox/graph";
import { emailHtml, inboxEmails, ingest } from "#/purchasing/inbox/ingest";
import { createTestDb } from "#/test/db";
import { pointPictures } from "./html";
import {
	backfillMarketHtml,
	ingestMarketMail,
	marketEmailHtml,
	marketMailPage,
} from "./market-mail";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

let n = 0;
const message = (subject: string): InboxMessage => {
	n++;
	return {
		graphId: `g${n}`,
		messageId: `<${n}@mail>`,
		receivedAt: new Date(Date.UTC(2026, 9, 21, 12, n)),
		subject,
		fromAddress: "seller-notification@amazon.com",
		fromName: null,
		recipients: ["marketplaces@eastcoastdrywall.com"],
	};
};
const file = (filename: string) => ({
	filename,
	contentType: "image/png",
	size: 3,
	data: Buffer.from("png"),
});
// As messageContent reads one: a logo shown inside, and a file attached.
const read = async () => ({
	body: "Sold!",
	html: '<p><img src="cid:logo@amz"> <b>Sold!</b></p>',
	attachments: [file("label.png")],
	inline: [{ ...file("logo.png"), contentId: "logo@amz" }],
});

test("pictures point at what katasync kept", () => {
	expect(
		pointPictures('<img src="cid:a"><img src="cid:a"><img src="cid:b">', [
			{ contentId: "a", url: "/x/1" },
		]),
	).toBe('<img src="/x/1"><img src="/x/1"><img src="cid:b">');
});

describe("keeping an email as sent", () => {
	test("marketplace: its pictures kept and shown, not listed as files", async () => {
		await ingestMarketMail(db, [message("Sold, ship now")], read);
		const [email] = (await marketMailPage(db, "orders", null)).emails;
		expect(email.attachments.map((a) => a.filename)).toEqual(["label.png"]);
		expect(await marketEmailHtml(db, email.id)).toMatch(
			/<img src="\/api\/market-email-attachments\/\d+"> <b>Sold!<\/b>/,
		);
	});

	test("purchasing: the same", async () => {
		await ingest(db, [message("Your quote")], read);
		const [email] = await inboxEmails(db, "to-file");
		expect(email.attachments.map((a) => a.filename)).toEqual(["label.png"]);
		expect(await emailHtml(db, email.id)).toMatch(
			/src="\/api\/po-email-attachments\/\d+"/,
		);
	});

	test("emails kept before HTML was: fetched later; gone ones keep their text", async () => {
		const textOnly = async () => ({ body: "Text", attachments: [] });
		const [found, gone, failing] = [
			message("Found"),
			message("Gone"),
			message("Failing"),
		];
		await ingestMarketMail(db, [found, gone, failing], textOnly);
		const ids = (await marketMailPage(db, "updates", null)).emails;
		const byName = (s: string) => ids.find((e) => e.subject === s)?.id ?? 0;
		expect(await marketEmailHtml(db, byName("Found"))).toBeNull();

		const done = await backfillMarketHtml(db, async (messageId) => {
			if (messageId === failing.messageId) throw new Error("Graph 500");
			return messageId === found.messageId
				? { html: "<p>Found</p>", inline: [] }
				: null;
		});
		expect(done).toBe(3);
		expect(await marketEmailHtml(db, byName("Found"))).toBe("<p>Found</p>");
		// Gone from the mailbox: nothing to show formatted, and not asked again.
		expect(await marketEmailHtml(db, byName("Gone"))).toBeNull();
		// A failure is tried again next run; the others aren't.
		const again: string[] = [];
		await backfillMarketHtml(db, async (messageId) => {
			again.push(messageId);
			return null;
		});
		expect(again).toEqual([failing.messageId]);
	});
});

describe("reading an email from Microsoft 365", () => {
	test("pictures it shows apart from files; ones it doesn't, dropped", async () => {
		vi.stubEnv("MS_GRAPH_TENANT_ID", "t");
		vi.stubEnv("MS_GRAPH_CLIENT_ID", "c");
		vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "s");
		vi.stubEnv("MARKETPLACE_INBOX", "marketplaces@eastcoastdrywall.com");
		vi.stubGlobal("fetch", async (url: string) => {
			if (url.includes("login.microsoftonline.com"))
				return Response.json({ access_token: "token", expires_in: 3600 });
			if (url.includes("$select=body"))
				return Response.json({
					body: { content: '<img src="cid:shown@x"> hello' },
				});
			const contentIds: Record<string, string | null> = {
				shown: "<shown@x>",
				signature: "sig@x",
				invoice: null,
			};
			const one = url.match(/\/attachments\/(\w+)$/)?.[1];
			if (one)
				return Response.json({
					contentBytes: Buffer.from("abc").toString("base64"),
					contentId: contentIds[one],
				});
			// As Graph does: the list is of any attachment, so a file's own
			// fields can't be selected there.
			if (/\$select=[^&]*(contentId|contentBytes)/.test(url))
				return Response.json(
					{ error: { message: "Could not find a property named 'contentId'" } },
					{ status: 400 },
				);
			const a = (id: string, isInline: boolean) => ({
				"@odata.type": "#microsoft.graph.fileAttachment",
				id,
				name: `${id}.png`,
				contentType: "image/png",
				size: 3,
				isInline,
			});
			return Response.json({
				value: [a("shown", true), a("signature", true), a("invoice", false)],
			});
		});
		const got = await messageHtml("g1", "marketplaces");
		expect(got.html).toContain("cid:shown@x");
		expect(got.inline.map((p) => [p.filename, p.contentId])).toEqual([
			["shown.png", "shown@x"],
		]);
		expect(got.inline[0]?.data?.toString()).toBe("abc");
		expect(got.attachments.map((a) => a.filename)).toEqual(["invoice.png"]);
	});

	test("an email attached to one is kept as its .eml; an invite isn't", async () => {
		vi.stubEnv("MS_GRAPH_TENANT_ID", "t");
		vi.stubEnv("MS_GRAPH_CLIENT_ID", "c");
		vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "s");
		vi.stubEnv("MARKETPLACE_INBOX", "marketplaces@eastcoastdrywall.com");
		const mime = "Subject: Delivery delayed\r\n\r\nTruck is late.";
		vi.stubGlobal("fetch", async (url: string) => {
			if (url.includes("login.microsoftonline.com"))
				return Response.json({ access_token: "token", expires_in: 3600 });
			if (url.includes("$select=body"))
				return Response.json({ body: { content: "see attached" } });
			if (url.endsWith("/attachments/fwd/$value")) return new Response(mime);
			if (url.endsWith("/attachments/invite/$value"))
				return Response.json(
					{ error: { message: "Not a message" } },
					{ status: 400 },
				);
			const item = (id: string, name: string) => ({
				"@odata.type": "#microsoft.graph.itemAttachment",
				id,
				name,
				contentType: null,
				size: 900,
				isInline: false,
			});
			return Response.json({
				value: [item("fwd", "Delivery delayed"), item("invite", "Call")],
			});
		});
		const got = await messageHtml("g1", "marketplaces");
		expect(got.attachments).toEqual([
			{
				filename: "Delivery delayed.eml",
				contentType: "message/rfc822",
				size: mime.length,
				data: Buffer.from(mime),
			},
		]);
	});
});
