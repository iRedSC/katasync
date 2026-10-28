import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
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

// Everything stored for a PO, without the ids restoring renumbers.
async function everythingOn(id: number) {
	const [po] = await db
		.select()
		.from(schema.purchaseOrders)
		.where(eq(schema.purchaseOrders.id, id));
	const lines = (
		await db
			.select()
			.from(schema.purchaseOrderLines)
			.where(eq(schema.purchaseOrderLines.purchaseOrderId, id))
			.orderBy(schema.purchaseOrderLines.id)
	).map(({ id: _id, ...l }) => l);
	const charges = (
		await db
			.select()
			.from(schema.purchaseOrderCharges)
			.where(eq(schema.purchaseOrderCharges.purchaseOrderId, id))
			.orderBy(schema.purchaseOrderCharges.id)
	).map(({ id: _id, ...c }) => c);
	const excluded = await db
		.select()
		.from(schema.purchaseOrderExcludedCatalogs)
		.where(eq(schema.purchaseOrderExcludedCatalogs.purchaseOrderId, id));
	return { po, lines, charges, excluded };
}

test("a deleted draft comes back as it was, charges and settings too", async () => {
	const blade = await createProduct(db, "BLADE", "simple");
	const knife = await createProduct(db, "KNIFE", "simple");
	const [catalog] = await db
		.insert(schema.catalogs)
		.values({ name: "Knives" })
		.returning();
	const [draft] = await db
		.insert(schema.purchaseOrders)
		.values({
			supplierId,
			locationId,
			notes: "Ring the bell",
			coverDays: 45,
			includePricier: true,
			createdAt: new Date("2026-10-01T12:00:00Z"),
		})
		.returning();
	await db.insert(schema.purchaseOrderLines).values([
		{
			purchaseOrderId: draft.id,
			productId: knife,
			supplierCount: 1,
			quantity: 3,
			unitCost: 2.5,
			locked: true,
			addedAt: new Date("2026-10-02T12:00:00Z"),
		},
		{
			purchaseOrderId: draft.id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			quantity: 1,
			addedAt: new Date("2026-10-01T12:00:00Z"),
		},
	]);
	await db.insert(schema.purchaseOrderCharges).values([
		{
			purchaseOrderId: draft.id,
			kind: "freight",
			amount: 12.5,
			createdAt: new Date("2026-10-03T12:00:00Z"),
		},
		{ purchaseOrderId: draft.id, kind: "credit", amount: -4 },
	]);
	await db
		.insert(schema.purchaseOrderExcludedCatalogs)
		.values({ purchaseOrderId: draft.id, catalogId: catalog.id });
	const before = await everythingOn(draft.id);

	await restoreDraft(db, await deleteDraft(db, draft.id));
	expect(await everythingOn(draft.id)).toEqual(before);
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
