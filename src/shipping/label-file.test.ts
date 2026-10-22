import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { addDispatch, createTestDb } from "#/test/db";
import { labelPdf } from "./label-file";

let db: Db;
let shipmentId: number;
let pdf: Buffer;

beforeEach(async () => {
	db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "o1",
			name: "#1",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 10,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	({
		boxIds: [shipmentId],
	} = await addDispatch(db, {
		orderIds: [order.id],
		contentsKey: "X×1",
		boxes: [
			{
				cost: 5,
				labelUrl: "https://shippo.example/label.pdf",
				externalId: "tx1",
			},
		],
	}));
	pdf = Buffer.from(await (await PDFDocument.create()).save());
});

afterEach(() => vi.unstubAllGlobals());

describe("labelPdf saves only a PDF", () => {
	test("an HTTP 200 page saves nothing, and the next attempt gets the PDF", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response("<html>maintenance</html>"),
		);
		await expect(labelPdf(db, shipmentId)).rejects.toThrow("PDF label");

		vi.stubGlobal("fetch", async () => new Response(new Uint8Array(pdf)));
		expect(await labelPdf(db, shipmentId)).toEqual(pdf);
	});

	test("a truncated download is refused", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(new Uint8Array(pdf.subarray(0, pdf.length - 20))),
		);
		await expect(labelPdf(db, shipmentId)).rejects.toThrow("PDF label");
	});

	test("a download over the byte limit is refused", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(new Uint8Array(10_000_001)),
		);
		await expect(labelPdf(db, shipmentId)).rejects.toThrow("over 10 MB");
	});

	test("a saved copy that isn't a PDF is dropped and fetched again", async () => {
		await db
			.update(schema.shipments)
			.set({ labelPdf: Buffer.from("<html>") })
			.where(eq(schema.shipments.id, shipmentId));
		const download = vi.fn(async () => new Response(new Uint8Array(pdf)));
		vi.stubGlobal("fetch", download);

		expect(await labelPdf(db, shipmentId)).toEqual(pdf);
		expect(download).toHaveBeenCalledTimes(1);
	});
});

describe("labelPdf", () => {
	test("downloads a label once, then prints from the saved copy", async () => {
		const download = vi.fn(async () => new Response(new Uint8Array(pdf)));
		vi.stubGlobal("fetch", download);

		expect(await labelPdf(db, shipmentId)).toEqual(pdf);
		expect(await labelPdf(db, shipmentId)).toEqual(pdf);
		expect(download).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledWith("https://shippo.example/label.pdf");
	});

	test("a failed download saves nothing, so the next print tries again", async () => {
		vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
		await expect(labelPdf(db, shipmentId)).rejects.toThrow("404");

		vi.stubGlobal("fetch", async () => new Response(new Uint8Array(pdf)));
		expect(await labelPdf(db, shipmentId)).toEqual(pdf);
	});
});
