import { gunzipSync } from "node:zlib";
import { type } from "arktype";
import { parse } from "csv-parse/sync";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { shipmentAdjustments, shipments } from "#/db/schema";
import { shippo, shippoGet } from "./shippo";

// What Shippo billed on katasync's labels after buying them: the carrier
// re-billing for a size or weight other than declared, surcharges, and
// credits back. Shippo bills these for its own carrier accounts (ours for
// USPS and UPS), usually 30 to 60 days after shipping, as invoice items tied
// to the label's transaction. Its old invoice API is gone; this asks its
// reporting API for an invoice report, waits for it, and reads the file.
// Nothing in it says what the carrier measured.

// Invoice items that are a label's re-bill, not its purchase or refund.
export const REBILL_TYPES = new Set([
	"LABEL_PAYMENT_ADJUSTMENT",
	"LABEL_SURCHARGE",
	"LABEL_REFUND_ADJUSTMENT",
]);

// One run covers at most 92 days; that's past when re-bills come.
const BACK_MS = 92 * 24 * 60 * 60 * 1000;
const POLL_MS = 3000;
const WAIT_MS = 2 * 60 * 1000;

const COLUMNS = [
	"invoice_item_object_id",
	"invoice_item_type",
	"invoice_item_description",
	"invoice_item_amount",
	"invoice_item_created_at",
	"transaction_object_id",
] as const;

const catalog = type({ data_availability: { end: "number" } });
const run = type({
	id: "string",
	status: "'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED'",
	"result?": type({ download: { url: "string" } }).or("null"),
	"error?": "unknown",
});
const row = type({
	invoice_item_object_id: "string > 0",
	invoice_item_type: "string",
	invoice_item_description: "string",
	invoice_item_amount: "string.numeric.parse",
	invoice_item_created_at: "string.date.iso.parse",
	transaction_object_id: "string",
});

export type ShippoRebill = {
	externalId: string;
	type: string;
	description: string;
	amount: number;
	postedAt: Date;
	transactionId: string;
};

// The re-bills in a report file's text, one per invoice item. Amounts are
// Shippo's: positive is a charge, negative a credit. Anything that isn't a
// label's re-bill is left out.
export function readRebills(csv: string): ShippoRebill[] {
	const records: unknown[] = parse(csv, {
		columns: true,
		skip_empty_lines: true,
	});
	return records
		.map((r) => row.assert(r))
		.filter((r) => REBILL_TYPES.has(r.invoice_item_type))
		.map((r) => ({
			externalId: r.invoice_item_object_id,
			type: r.invoice_item_type,
			description: r.invoice_item_description.trim() || r.invoice_item_type,
			amount: r.invoice_item_amount,
			postedAt: r.invoice_item_created_at,
			transactionId: r.transaction_object_id,
		}));
}

// Shippo's re-bills over the last 92 days its reports cover.
export async function fetchShippoRebills(): Promise<ShippoRebill[]> {
	const { data_availability } = catalog.assert(
		await shippoGet("/v2/reporting/reports/invoice.v1"),
	);
	const end = data_availability.end;
	const start = end - BACK_MS / 1000;
	let r = run.assert(
		await shippo("/v2/reporting/runs", {
			report_type: "invoice.v1",
			interval: { start, end },
			columns: COLUMNS,
			output_format: "csv_gzip",
			// The same window twice is the same report.
			idempotency_key: `katasync-rebills-${end}`,
		}),
	);
	const until = Date.now() + WAIT_MS;
	while (r.status === "QUEUED" || r.status === "PROCESSING") {
		if (Date.now() > until)
			throw new Error("Shippo's invoice report took too long; next time");
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		r = run.assert(await shippoGet(`/v2/reporting/runs/${r.id}`));
	}
	if (r.status === "FAILED" || !r.result)
		throw new Error(
			`Shippo's invoice report failed: ${JSON.stringify(r.error)}`,
		);
	const file = await fetch(r.result.download.url);
	if (!file.ok)
		throw new Error(`Shippo's report download answered ${file.status}`);
	return readRebills(
		gunzipSync(Buffer.from(await file.arrayBuffer())).toString("utf8"),
	);
}

// Saves re-bills on katasync's labels, matched by Shippo transaction.
// Again is harmless: a line already saved takes Shippo's latest figures. A
// re-bill on a label bought elsewhere in Shippo has no shipment here and is
// only counted.
export async function saveShippoRebills(db: Db, rebills: ShippoRebill[]) {
	const ids = [...new Set(rebills.map((r) => r.transactionId))];
	const labels =
		ids.length === 0
			? []
			: await db
					.select({ id: shipments.id, externalId: shipments.externalId })
					.from(shipments)
					.where(
						and(
							eq(shipments.provider, "shippo"),
							inArray(shipments.externalId, ids),
						),
					);
	const byTransaction = new Map(labels.map((l) => [l.externalId, l.id]));
	const rows = rebills.flatMap((r) => {
		const shipmentId = byTransaction.get(r.transactionId);
		if (shipmentId === undefined || Math.round(r.amount * 100) === 0) return [];
		return [
			{
				shipmentId,
				externalId: r.externalId,
				type: r.type,
				description: r.description,
				amount: Math.round(r.amount * 100) / 100,
				postedAt: r.postedAt,
			},
		];
	});
	if (rows.length > 0)
		await db
			.insert(shipmentAdjustments)
			.values(rows)
			.onConflictDoUpdate({
				target: shipmentAdjustments.externalId,
				set: {
					type: sql`excluded.type`,
					description: sql`excluded.description`,
					amount: sql`excluded.amount`,
					postedAt: sql`excluded.posted_at`,
				},
			});
	return {
		rebills: rebills.length,
		saved: rows.length,
		elsewhere: rebills.filter((r) => !byTransaction.has(r.transactionId))
			.length,
	};
}

export async function importShippoRebills(db: Db) {
	return saveShippoRebills(db, await fetchShippoRebills());
}
