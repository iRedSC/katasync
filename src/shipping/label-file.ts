import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { shipments } from "#/db/schema";
import { tiktokLabel } from "./tiktok";

// A label's PDF: the saved copy, or else fetched from the provider and
// saved, so every later print is local. TikTok's links expire in a day, so
// TikTok labels are looked up by package ID instead of a stored link.
export async function labelPdf(db: Db, shipmentId: number): Promise<Buffer> {
	const [row] = await db
		.select({
			pdf: shipments.labelPdf,
			provider: shipments.provider,
			externalId: shipments.externalId,
			labelUrl: shipments.labelUrl,
		})
		.from(shipments)
		.where(eq(shipments.id, shipmentId));
	if (!row) throw new Error(`No label ${shipmentId}`);
	if (row.pdf) return row.pdf;

	const url =
		row.provider === "tiktok"
			? (await tiktokLabel(row.externalId)).url
			: row.labelUrl;
	if (!url) throw new Error("The provider gave no link for this label");
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`The label download failed: ${response.status}`);
	}
	const pdf = Buffer.from(await response.arrayBuffer());
	await db
		.update(shipments)
		.set({ labelPdf: pdf })
		.where(eq(shipments.id, shipmentId));
	return pdf;
}
