import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import type { Db } from "#/db/client";
import { shipments } from "#/db/schema";
import { appendAerosolMark } from "./hazmat";
import { tiktokLabel } from "./tiktok";

// Past this, a download isn't a shipping label. Bounds what one may take.
const MAX_LABEL_BYTES = 10_000_000;

// What prints: the provider's label, then the Limited Quantity mark for a
// box with aerosols. Every print and reprint goes through here, so the mark
// can't be left off.
export async function printablePdf(db: Db, shipmentId: number) {
	const [pdf, [row]] = await Promise.all([
		labelPdf(db, shipmentId),
		db
			.select({ hazmat: shipments.hazmat })
			.from(shipments)
			.where(eq(shipments.id, shipmentId)),
	]);
	return row?.hazmat ? appendAerosolMark(pdf) : pdf;
}

// A label's PDF: the saved copy, or else fetched from the provider and
// saved, so every later print is local. TikTok's links expire in a day, so
// TikTok labels are looked up by package ID instead of a stored link, which
// also brings the tracking number if the handoff didn't get it.
export async function labelPdf(db: Db, shipmentId: number): Promise<Buffer> {
	const [row] = await db
		.select({
			pdf: shipments.labelPdf,
			provider: shipments.provider,
			externalId: shipments.externalId,
			labelUrl: shipments.labelUrl,
			trackingNumber: shipments.trackingNumber,
		})
		.from(shipments)
		.where(eq(shipments.id, shipmentId));
	if (!row) throw new Error(`No label ${shipmentId}`);
	if (row.pdf) {
		if (await isLabelPdf(row.pdf)) return row.pdf;
		// Not a label (saved before this check, or a page that wasn't a PDF).
		// Dropped, so the provider is asked again.
		await db
			.update(shipments)
			.set({ labelPdf: null })
			.where(eq(shipments.id, shipmentId));
	}

	let url = row.labelUrl;
	if (row.provider === "tiktok") {
		const label = await tiktokLabel(row.externalId);
		url = label.url;
		// Shipping may have gone ahead before TikTok had the number ready.
		if (label.trackingNumber && !row.trackingNumber) {
			await db
				.update(shipments)
				.set({ trackingNumber: label.trackingNumber })
				.where(eq(shipments.id, shipmentId));
		}
	}
	if (!url) throw new Error("The provider gave no link for this label");
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`The label download failed: ${response.status}`);
	}
	const pdf = await readCapped(response, MAX_LABEL_BYTES);
	// A 200 only says the provider answered. Only a PDF is saved.
	if (!(await isLabelPdf(pdf)))
		throw new Error("The provider's link didn't give a PDF label");
	await db
		.update(shipments)
		.set({ labelPdf: pdf })
		.where(eq(shipments.id, shipmentId));
	return pdf;
}

// A PDF that opens and ends where one should. A page of HTML fails the first
// check, and a cut-off download the second.
async function isLabelPdf(bytes: Uint8Array) {
	if (bytes.length > MAX_LABEL_BYTES) return false;
	const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
	const tail = Buffer.from(bytes.subarray(-1024)).toString("latin1");
	if (head !== "%PDF-" || !tail.includes("%%EOF")) return false;
	try {
		await PDFDocument.load(bytes);
		return true;
	} catch {
		return false;
	}
}

// The body's bytes, stopping as soon as it passes `max`, so an endless or
// huge response can't fill memory.
async function readCapped(response: Response, max: number) {
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			throw new Error(`The label is over ${max / 1_000_000} MB`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, size);
}
