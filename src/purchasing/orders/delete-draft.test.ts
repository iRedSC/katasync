import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { addPoFile, createFileUploadLink } from "../files";
import { deleteDraft, restoreDraft } from "./delete-draft";

let db: Db;
let supplierId: number;
let locationId: number;

async function po(status: "suggested" | "draft") {
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
	return row?.status;
}

const linksOf = (purchaseOrderId: number) =>
	db
		.select()
		.from(schema.poFileUploads)
		.where(eq(schema.poFileUploads.purchaseOrderId, purchaseOrderId));

// A draft thrown away, and a suggestion that takes its place for the supplier.
async function deleteThenSuggest() {
	const deleted = await deleteDraft(db, await po("draft"));
	const suggested = await po("suggested");
	return { deleted, suggested };
}

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

describe("restoring a draft over a suggestion", () => {
	test("takes the suggestion's upload links with it, live or expired", async () => {
		const { deleted, suggested } = await deleteThenSuggest();
		await createFileUploadLink(db, suggested);
		await createFileUploadLink(db, suggested, new Date("2026-10-01T12:00:00Z"));
		await restoreDraft(db, deleted);
		expect(await statusOf(deleted.id)).toBe("draft");
		expect(await statusOf(suggested)).toBeUndefined();
		expect(await linksOf(suggested)).toEqual([]);
	});

	test("a suggestion with no link restores as before", async () => {
		const { deleted, suggested } = await deleteThenSuggest();
		await restoreDraft(db, deleted);
		expect(await statusOf(deleted.id)).toBe("draft");
		expect(await statusOf(suggested)).toBeUndefined();
	});

	test("refused once the suggestion has become a draft with a file", async () => {
		const { deleted, suggested } = await deleteThenSuggest();
		await addPoFile(db, {
			purchaseOrderId: suggested,
			filename: "quote.eml",
			contentType: "",
			data: new Uint8Array([1]),
			addedBy: "staff",
		});
		await expect(restoreDraft(db, deleted)).rejects.toThrow(/new draft/);
		expect(await statusOf(suggested)).toBe("draft");
	});

	test("refused while the suggestion has a file on it, and changes nothing", async () => {
		const { deleted, suggested } = await deleteThenSuggest();
		await createFileUploadLink(db, suggested);
		await db.insert(schema.purchaseOrderFiles).values({
			purchaseOrderId: suggested,
			filename: "x.eml",
			contentType: "message/rfc822",
			size: 3,
			data: Buffer.from("abc"),
			addedBy: "staff",
		});
		await expect(restoreDraft(db, deleted)).rejects.toThrow(
			/remove them first/,
		);
		expect(await statusOf(suggested)).toBe("suggested");
		expect(await linksOf(suggested)).toHaveLength(1);
		expect(await statusOf(deleted.id)).toBeUndefined();
	});
});
