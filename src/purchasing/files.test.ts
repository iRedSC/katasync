import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { MAX_PO_FILE_BYTES } from "./file-limits";
import {
	addPoFile,
	createFileUploadLink,
	fileUploadResponse,
	movePoFiles,
	poFile,
	poFilesOf,
	poForUploadLink,
	setPoFileRemoved,
	setPoFilesRemoved,
	unmovePoFiles,
} from "./files";
import { deleteDraft } from "./orders";

let db: Db;
let supplierId: number;
let locationId: number;

const bytes = (s: string) => new TextEncoder().encode(s);

async function po(status: "suggested" | "draft" | "sent") {
	const [row] = await db
		.insert(schema.purchaseOrders)
		.values({ supplierId, locationId, status })
		.returning();
	return row.id;
}

async function statusOf(id: number) {
	const [row] = await db
		.select({ status: schema.purchaseOrders.status })
		.from(schema.purchaseOrders)
		.where(eq(schema.purchaseOrders.id, id));
	return row.status;
}

const add = (
	purchaseOrderId: number,
	filename = "quote.pdf",
	data = "not really a pdf",
) =>
	addPoFile(db, {
		purchaseOrderId,
		filename,
		contentType: "",
		data: bytes(data),
		addedBy: "staff",
	});

beforeEach(async () => {
	db = await createTestDb();
	const [supplier] = await db
		.insert(schema.suppliers)
		.values({ code: "CANAM", name: "CanAm" })
		.returning();
	const [location] = await db
		.insert(schema.locations)
		.values({ name: "Shop", kind: "owned" })
		.returning();
	supplierId = supplier.id;
	locationId = location.id;
});

describe("a PO's own files", () => {
	test("kept with a type from the name, and listed newest first", async () => {
		const id = await po("sent");
		await add(id, "quote.pdf");
		await add(id, "bol.eml", "not really an email");
		const files = await poFilesOf(db, id);
		expect(files.map((f) => [f.filename, f.contentType])).toEqual([
			["bol.eml", "message/rfc822"],
			["quote.pdf", "application/pdf"],
		]);
		expect((await poFile(db, files[0].id))?.data.toString()).toBe(
			"not really an email",
		);
	});

	test("removed and put back; neither twice", async () => {
		const id = await po("sent");
		const file = await add(id);
		await setPoFileRemoved(db, file.id);
		expect(await poFilesOf(db, id)).toEqual([]);
		await expect(setPoFileRemoved(db, file.id)).rejects.toThrow(/already off/);
		await setPoFileRemoved(db, file.id, false);
		expect((await poFilesOf(db, id)).map((f) => f.id)).toEqual([file.id]);
		await expect(setPoFileRemoved(db, file.id, false)).rejects.toThrow(
			/is on its PO/,
		);
	});

	test("refuses empty, nameless, and too-large files", async () => {
		const id = await po("sent");
		const base = {
			purchaseOrderId: id,
			contentType: "",
			addedBy: "staff" as const,
		};
		await expect(
			addPoFile(db, { ...base, filename: "a.pdf", data: new Uint8Array() }),
		).rejects.toThrow(/empty/);
		await expect(
			addPoFile(db, { ...base, filename: "   ", data: bytes("x") }),
		).rejects.toThrow(/needs a name/);
		await expect(
			addPoFile(db, {
				...base,
				filename: "big.pdf",
				data: new Uint8Array(MAX_PO_FILE_BYTES + 1),
			}),
		).rejects.toThrow(/up to/);
	});

	test("a suggested PO becomes a draft with its first file", async () => {
		const id = await po("suggested");
		await add(id);
		expect(await statusOf(id)).toBe("draft");
	});

	test("a draft is only thrown away once its files are off it", async () => {
		const id = await po("draft");
		const file = await add(id);
		await expect(deleteDraft(db, id)).rejects.toThrow(/remove them first/);
		await setPoFileRemoved(db, file.id);
		await deleteDraft(db, id);
		expect(await poFile(db, file.id)).toBeNull();
	});
});

async function emailedFile(purchaseOrderId: number, data: string) {
	const [email] = await db
		.insert(schema.poEmails)
		.values({
			messageId: `<${Math.random()}@x>`,
			fromAddress: "orders@supplier.com",
			recipients: [],
			subject: "Your order",
			body: "",
			receivedAt: new Date(),
			purchaseOrderId,
			matchedBy: "staff",
		})
		.returning();
	const [file] = await db
		.insert(schema.poEmailAttachments)
		.values({
			emailId: email.id,
			filename: "Order Confirmation.pdf",
			contentType: "application/pdf",
			size: data.length,
			data: Buffer.from(data),
		})
		.returning();
	return file.id;
}

describe("the same file twice", () => {
	test("isn't added again, as its own or an email's", async () => {
		const id = await po("sent");
		await add(id, "quote.pdf");
		await expect(add(id, "quote.pdf")).rejects.toThrow(
			/quote\.pdf is already on this PO$/,
		);
		await expect(add(id, "copy.pdf")).rejects.toThrow(/as quote\.pdf/);
		await emailedFile(id, "confirmation");
		await expect(
			addPoFile(db, {
				purchaseOrderId: id,
				filename: "saved.pdf",
				contentType: "",
				data: bytes("confirmation"),
				addedBy: "claude",
			}),
		).rejects.toThrow(/as Order Confirmation\.pdf/);
		// Another PO, or this one once it's off, takes it.
		await add(await po("sent"), "quote.pdf");
		const [file] = await poFilesOf(db, id);
		await setPoFileRemoved(db, file.id);
		await add(id, "quote.pdf");
	});

	test("comes off with its copies, and back unless the PO has it again", async () => {
		const id = await po("sent");
		const file = await add(id);
		const attachment = await emailedFile(id, "confirmation");
		const ids = { files: [file.id], attachments: [attachment] };
		expect(await setPoFilesRemoved(db, ids, true)).toEqual({
			files: 1,
			attachments: 1,
		});
		const again = await add(id);
		expect(await setPoFilesRemoved(db, ids, false)).toEqual({
			files: 0,
			attachments: 1,
		});
		expect((await poFilesOf(db, id)).map((f) => f.id)).toEqual([again.id]);
	});
});

describe("moving a file to another PO", () => {
	const onPo = async (id: number) =>
		(await poFilesOf(db, id)).map((f) => f.filename);
	const emailedOn = async (id: number) =>
		(
			await db
				.select({ removedAt: schema.poEmailAttachments.removedAt })
				.from(schema.poEmailAttachments)
				.where(eq(schema.poEmailAttachments.id, id))
		)[0].removedAt === null;

	test("an email's file goes over as the other PO's own, and back with Undo", async () => {
		const from = await po("sent");
		const to = await po("sent");
		const attachment = await emailedFile(from, "backorder ack");
		const moved = await movePoFiles(db, {
			from,
			to,
			files: [],
			attachments: [attachment],
			movedBy: "staff",
		});
		expect(moved.added).not.toBeNull();
		expect(await onPo(to)).toEqual(["Order Confirmation.pdf"]);
		expect((await poFile(db, moved.added ?? 0))?.data.toString()).toBe(
			"backorder ack",
		);
		expect(await emailedOn(attachment)).toBe(false);
		const [there] = await poFilesOf(db, to);
		expect(there.sentBy).toBe("orders@supplier.com");

		await unmovePoFiles(db, { ...moved, files: [], attachments: [attachment] });
		expect(await onPo(to)).toEqual([]);
		expect(await emailedOn(attachment)).toBe(true);
	});

	test("one the other PO has already is only taken off, and Undo leaves it", async () => {
		const from = await po("sent");
		const to = await po("sent");
		const attachment = await emailedFile(from, "same bytes");
		await add(to, "mine.pdf", "same bytes");
		const moved = await movePoFiles(db, {
			from,
			to,
			files: [],
			attachments: [attachment],
			movedBy: "claude",
		});
		expect(moved.added).toBeNull();
		expect(await emailedOn(attachment)).toBe(false);
		await unmovePoFiles(db, { ...moved, files: [], attachments: [attachment] });
		expect(await onPo(to)).toEqual(["mine.pdf"]);
		expect(await emailedOn(attachment)).toBe(true);
	});

	test("its own files too, all copies at once", async () => {
		const from = await po("sent");
		const to = await po("draft");
		const file = await add(from, "quote.pdf", "q");
		const attachment = await emailedFile(from, "q");
		await movePoFiles(db, {
			from,
			to,
			files: [file.id],
			attachments: [attachment],
			movedBy: "staff",
		});
		expect(await onPo(from)).toEqual([]);
		expect(await emailedOn(attachment)).toBe(false);
		expect(await onPo(to)).toHaveLength(1);
		// Moved on again, it still says who sent it.
		const [copy] = await poFilesOf(db, to);
		const next = await po("sent");
		await movePoFiles(db, {
			from: to,
			to: next,
			files: [copy.id],
			attachments: [],
			movedBy: "staff",
		});
		expect((await poFilesOf(db, next))[0].sentBy).toBe("orders@supplier.com");
	});

	test("refuses a file not on the PO it says, or the PO it is on; a suggested one becomes a draft", async () => {
		const from = await po("sent");
		const other = await po("sent");
		const attachment = await emailedFile(other, "x");
		const move = (to: number, attachments = [attachment]) =>
			movePoFiles(db, { from, to, files: [], attachments, movedBy: "staff" });
		await expect(move(await po("sent"))).rejects.toThrow(/isn't on PO/);
		await expect(move(from)).rejects.toThrow(/already/);
		const mine = await emailedFile(from, "y");
		const suggested = await po("suggested");
		await move(suggested, [mine]);
		expect(await statusOf(suggested)).toBe("draft");
	});
});

describe("uploading", () => {
	test("by link, for Claude, until it expires", async () => {
		const id = await po("sent");
		const now = new Date("2026-10-22T12:00:00Z");
		const { token } = await createFileUploadLink(db, id, now);
		expect(await poForUploadLink(db, token, now)).toBe(id);
		expect(
			await poForUploadLink(db, token, new Date(now.getTime() + 31 * 60_000)),
		).toBeNull();
		expect(await poForUploadLink(db, "made-up", now)).toBeNull();
	});

	test("each file of a form; a bad one says why and keeps those before it", async () => {
		const id = await po("sent");
		const form = new FormData();
		form.append("file", new File([bytes("one")], "slip.pdf"));
		form.append("file", new File([], "empty.pdf"));
		const res = await fileUploadResponse(
			db,
			id,
			new Request("http://x/upload", { method: "POST", body: form }),
			"claude",
		);
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error).toMatch(/empty\.pdf is empty/);
		expect(body.fileIds).toHaveLength(1);
		const [kept] = await poFilesOf(db, id);
		expect([kept.filename, kept.addedBy]).toEqual(["slip.pdf", "claude"]);
	});

	test("a raw body, named by ?name=", async () => {
		const id = await po("sent");
		const res = await fileUploadResponse(
			db,
			id,
			new Request("http://x/upload?name=bol.png", {
				method: "POST",
				body: bytes("png"),
				headers: { "content-type": "image/png" },
			}),
			"claude",
		);
		expect(res.status).toBe(200);
		const [kept] = await poFilesOf(db, id);
		expect([kept.filename, kept.contentType]).toEqual(["bol.png", "image/png"]);
	});
});
