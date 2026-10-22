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
	poFile,
	poFilesOf,
	poForUploadLink,
	setPoFileRemoved,
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

const add = (purchaseOrderId: number, filename = "quote.pdf") =>
	addPoFile(db, {
		purchaseOrderId,
		filename,
		contentType: "",
		data: bytes("not really a pdf"),
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
		await add(id, "bol.eml");
		const files = await poFilesOf(db, id);
		expect(files.map((f) => [f.filename, f.contentType])).toEqual([
			["bol.eml", "message/rfc822"],
			["quote.pdf", "application/pdf"],
		]);
		expect((await poFile(db, files[0].id))?.data.toString()).toBe(
			"not really a pdf",
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
