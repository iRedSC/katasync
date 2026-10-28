import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { callMcp, callTool, freshDb } from "#/mcp/mcp.fixtures";
import { poAddress, poOfAddress } from "./graph";
import {
	countUnfiled,
	fileEmail,
	ingest,
	type ReadContent,
	setAside,
	setRead,
} from "./ingest";
import { findTracking, guessCarrier } from "./tracking-numbers";

describe("tracking numbers in an email", () => {
	test("finds UPS and USPS numbers, spaced or not", () => {
		expect(
			findTracking(
				"UPS: 1Z 999 AA1 01 2345 6784\nUSPS 9400 1000 0000 0000 0000 00",
			),
		).toEqual([
			{ carrier: "ups", number: "1Z999AA10123456784" },
			{ carrier: "usps", number: "9400100000000000000000" },
		]);
	});

	test("takes 12 digits as FedEx only when the email says FedEx", () => {
		const text = "Invoice 123456789012 attached";
		expect(findTracking(text)).toEqual([]);
		expect(findTracking(`${text}. Shipped FedEx 123456789012`)).toEqual([
			{ carrier: "fedex", number: "123456789012" },
		]);
	});

	test("leaves phone numbers and order numbers alone", () => {
		expect(
			findTracking("Call 555-123-4567. Order #9400100000000000000000"),
		).toEqual([]);
	});

	test("guesses a carrier from a number's shape", () => {
		expect(guessCarrier("1z999aa10123456784")).toBe("ups");
		expect(guessCarrier("EC123456789US")).toBe("usps");
		expect(guessCarrier("PRO 12345")).toBeNull();
	});
});

describe("PO addresses", () => {
	afterEach(() => vi.unstubAllEnvs());

	test("each PO has its own, and only ours name a PO", () => {
		vi.stubEnv("PO_INBOX", "Purchasing@EastCoastDrywall.com");
		expect(poAddress(1234)).toBe("purchasing+po1234@eastcoastdrywall.com");
		expect(poOfAddress("PURCHASING+PO1234@eastcoastdrywall.com")).toBe(1234);
		expect(poOfAddress("info+po1234@eastcoastdrywall.com")).toBeNull();
		expect(poOfAddress("purchasing+po1234@elsewhere.com")).toBeNull();
	});

	test("there are none until the inbox is set up", () => {
		vi.stubEnv("PO_INBOX", "");
		expect(poAddress(1234)).toBeNull();
	});
});

describe("reading the inbox", () => {
	let db: Db;
	let sent: number;
	let draft: number;
	beforeEach(async () => {
		vi.stubEnv("PO_INBOX", "purchasing@eastcoastdrywall.com");
		({ db } = await freshDb());
		const [location] = await db.select().from(schema.locations);
		const [tsw] = await db
			.insert(schema.suppliers)
			.values({ code: "TSW", name: "Tool Source", email: "orders@tsw.com" })
			.returning();
		const [other] = await db
			.insert(schema.suppliers)
			.values({ code: "CAN", name: "Can-Am", email: "po@canam.com" })
			.returning();
		[{ id: sent }] = await db
			.insert(schema.purchaseOrders)
			.values({
				supplierId: tsw.id,
				locationId: location.id,
				status: "sent",
				sentAt: new Date(),
			})
			.returning();
		[{ id: draft }] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: other.id, locationId: location.id })
			.returning();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	let n = 0;
	const message = (over: Partial<Parameters<typeof ingest>[1][number]>) => ({
		graphId: `g${++n}`,
		messageId: `<m${n}@tsw.com>`,
		receivedAt: new Date(),
		subject: "Hello",
		fromAddress: "rep@tsw.com",
		fromName: "Rep",
		recipients: ["purchasing@eastcoastdrywall.com"],
		...over,
	});
	const read: ReadContent = async () => ({
		body: "Thanks!",
		attachments: [
			{
				filename: "logo.txt",
				contentType: "text/plain",
				size: 2,
				data: Buffer.from("hi"),
			},
		],
	});
	const emails = () =>
		db.select().from(schema.poEmails).orderBy(schema.poEmails.id);

	test("files an email sent to a PO's own address, once", async () => {
		const m = message({
			recipients: [`purchasing+po${sent}@eastcoastdrywall.com`],
		});
		expect(await ingest(db, [m], read)).toEqual({
			read: 1,
			filed: 1,
			problems: [],
		});
		expect(await ingest(db, [m], read)).toMatchObject({ read: 0 });
		const [e] = await emails();
		expect(e).toMatchObject({ purchaseOrderId: sent, matchedBy: "address" });
		const files = await db.select().from(schema.poEmailAttachments);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ emailId: e.id, size: 2 });
	});

	test("files by subject only from the PO's supplier's domain", async () => {
		await ingest(
			db,
			[
				message({ subject: `RE: Purchase order ${sent} from ECD` }),
				message({
					subject: `RE: Purchase order ${sent} from ECD`,
					fromAddress: "someone@gmail.com",
				}),
			],
			read,
		);
		const [mine, stranger] = await emails();
		expect(mine).toMatchObject({ purchaseOrderId: sent, matchedBy: "subject" });
		expect(stranger.purchaseOrderId).toBeNull();
	});

	test("never files on a PO that hasn't been sent", async () => {
		await ingest(
			db,
			[message({ recipients: [`purchasing+po${draft}@eastcoastdrywall.com`] })],
			read,
		);
		expect((await emails())[0].purchaseOrderId).toBeNull();
	});

	test("follows tracking in a filed email without touching the PO", async () => {
		vi.stubEnv("SHIPPO_API_KEY", "shippo_test_x");
		const fetch = vi.fn(async () =>
			Response.json({
				eta: null,
				servicelevel: { name: "Ground" },
				address_from: { city: "Dallas", state: "TX" },
				address_to: null,
				tracking_status: { status: "TRANSIT", status_details: "In transit" },
				tracking_history: [
					{
						status: "PRE_TRANSIT",
						status_details: "Label created ",
						status_date: "2026-10-20T10:00:00Z",
						location: null,
					},
					{
						status: "IN_A_HOLE",
						status_details: "Departed",
						status_date: "2026-10-21T10:00:00Z",
						location: { city: "Memphis", state: "TN" },
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetch);
		await ingest(
			db,
			[message({ recipients: [`purchasing+po${sent}@eastcoastdrywall.com`] })],
			async () => ({ body: "Shipped UPS 1Z999AA10123456784", attachments: [] }),
		);
		const [t] = await db.select().from(schema.purchaseOrderTracking);
		expect(t).toMatchObject({
			purchaseOrderId: sent,
			carrier: "ups",
			number: "1Z999AA10123456784",
			status: "TRANSIT",
			service: "Ground",
			origin: "Dallas, TX",
			destination: null,
			history: [
				{
					status: "PRE_TRANSIT",
					detail: "Label created",
					at: "2026-10-20T10:00:00Z",
					place: null,
				},
				// A status Shippo adds later reads as unknown, not a failure.
				{
					status: "UNKNOWN",
					detail: "Departed",
					at: "2026-10-21T10:00:00Z",
					place: "Memphis, TN",
				},
			],
		});
		expect(String(fetch.mock.calls[0])).toContain(
			"/tracks/ups/1Z999AA10123456784",
		);
		const [po] = await db
			.select()
			.from(schema.purchaseOrders)
			.where(eq(schema.purchaseOrders.id, sent));
		expect(po.status).toBe("sent");
	});

	test("leaves an email naming two POs for a person", async () => {
		const [location] = await db.select().from(schema.locations);
		const [{ supplierId }] = await db
			.select({ supplierId: schema.purchaseOrders.supplierId })
			.from(schema.purchaseOrders)
			.where(eq(schema.purchaseOrders.id, sent));
		const [{ id: second }] = await db
			.insert(schema.purchaseOrders)
			.values({
				supplierId,
				locationId: location.id,
				status: "sent",
				sentAt: new Date(),
			})
			.returning();
		await ingest(
			db,
			[
				message({
					recipients: [
						`purchasing+po${sent}@eastcoastdrywall.com`,
						`purchasing+po${second}@eastcoastdrywall.com`,
					],
				}),
				message({
					subject: `Purchase order ${sent} and purchase order ${second}`,
				}),
			],
			read,
		);
		expect((await emails()).map((e) => e.purchaseOrderId)).toEqual([
			null,
			null,
		]);
	});

	test("moving an email moves its tracking, and the sweep catches tracking a run missed", async () => {
		vi.stubEnv("SHIPPO_API_KEY", "shippo_test_x");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ tracking_status: { status: "TRANSIT" } }),
			),
		);
		const [location] = await db.select().from(schema.locations);
		const [{ supplierId }] = await db
			.select({ supplierId: schema.purchaseOrders.supplierId })
			.from(schema.purchaseOrders)
			.where(eq(schema.purchaseOrders.id, sent));
		const [{ id: other }] = await db
			.insert(schema.purchaseOrders)
			.values({
				supplierId,
				locationId: location.id,
				status: "sent",
				sentAt: new Date(),
			})
			.returning();
		const m = message({
			recipients: [`purchasing+po${sent}@eastcoastdrywall.com`],
		});
		const withTracking: ReadContent = async () => ({
			body: "UPS 1Z999AA10123456784",
			attachments: [],
		});
		await ingest(db, [m], withTracking);
		const tracked = () =>
			db
				.select({ po: schema.purchaseOrderTracking.purchaseOrderId })
				.from(schema.purchaseOrderTracking);
		// As if the run stopped before following it.
		await db.delete(schema.purchaseOrderTracking);
		await ingest(db, [m], withTracking);
		expect(await tracked()).toEqual([]);
		await ingest(db, [m], withTracking, { retrack: true });
		expect(await tracked()).toEqual([{ po: sent }]);

		const [e] = await emails();
		await fileEmail(db, { emailId: e.id, purchaseOrderId: other, by: "staff" });
		expect(await tracked()).toEqual([{ po: other }]);
		await fileEmail(db, { emailId: e.id, purchaseOrderId: null, by: "staff" });
		expect(await tracked()).toEqual([]);
	});

	test("new emails arrive unread; only unread ones are counted", async () => {
		await ingest(db, [message({}), message({ subject: "Newsletter" })], read);
		const [first, second] = await emails();
		expect(await countUnfiled(db)).toMatchObject({
			toFile: 2,
			toFileUnread: 2,
		});
		await setRead(db, first.id, true);
		await setAside(db, second.id);
		expect(await countUnfiled(db)).toEqual({
			toFile: 1,
			setAside: 1,
			toFileUnread: 0,
			setAsideUnread: 1,
		});
	});

	test("Claude lists, reads, files, and sets aside emails", async () => {
		await ingest(db, [message({}), message({ subject: "Newsletter" })], read);
		const [first, second] = await emails();
		const tool = (name: string, args: Record<string, unknown>) =>
			callTool(db, true, name, args);

		const unfiled = await tool("po_emails", { unfiled: true });
		expect(unfiled.data.map((e: { id: number }) => e.id).sort()).toEqual(
			[first.id, second.id].sort(),
		);
		const full = await tool("read_po_email", { id: first.id });
		expect(full.data).toMatchObject({ body: "Thanks!", po: null });
		expect(full.data.attachments[0]).toMatchObject({ filename: "logo.txt" });

		expect(
			(await tool("file_po_email", { id: first.id, po: draft })).isError,
		).toBe(true);
		await tool("file_po_email", { id: first.id, po: sent });
		await tool("set_aside_po_email", { id: second.id });
		expect((await tool("po_emails", { unfiled: true })).data).toEqual([]);
		expect((await tool("po_emails", { po: sent })).data[0]).toMatchObject({
			id: first.id,
			matchedBy: "claude",
		});
		// A PO's emails come inside the untrusted tags, apart from its data.
		const po = await callMcp(db, true, "tools/call", {
			name: "get_purchase_order",
			arguments: { id: sent },
		});
		expect(po.content[1].text).toContain(`"id": ${first.id}`);

		await tool("set_aside_po_email", { id: second.id, undo: true });
		expect((await tool("po_emails", { unfiled: true })).data).toHaveLength(1);
	});
});

describe("PDF text", () => {
	test("reads an invoice's words, and nothing from a file that isn't one", async () => {
		const { PDFDocument, StandardFonts } = await import("pdf-lib");
		const doc = await PDFDocument.create();
		const page = doc.addPage();
		page.drawText("Invoice TSW-INV-58213 Total 412.50", {
			x: 50,
			y: 700,
			font: await doc.embedFont(StandardFonts.Helvetica),
		});
		const { pdfText } = await import("./pdf-text");
		expect(await pdfText(Buffer.from(await doc.save()))).toContain(
			"TSW-INV-58213",
		);
		expect(await pdfText(Buffer.from("not a pdf"))).toBeNull();
	});
});
