import { gunzipSync } from "node:zlib";
import { type } from "arktype";
import { parse } from "csv-parse/sync";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatchOrders,
	orders,
	shipmentAdjustments,
	shipments,
	stores,
} from "#/db/schema";
import { alertRebill, crossesLarge } from "#/inbox/rebill-alerts";
import { formatMoney } from "#/lib/format";
import { describeRebill, rebillReason } from "./rebill-reason";
import { shippo, shippoGet } from "./shippo";

// What Shippo billed on katasync's labels after buying them: the carrier
// re-billing for a size or weight other than declared, surcharges, and
// credits back. Shippo bills these for its own carrier accounts (ours for
// USPS and UPS), usually 30 to 60 days after shipping, as invoice items tied
// to the label's transaction. Its old invoice API is gone; this asks its
// reporting API for an invoice report, waits for it, and reads the file.
// A charge correction's description names the package as billed and as
// declared (src/shipping/rebill-reason.ts); a surcharge's only names it.

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

// What the report covers so far, in epoch seconds; nothing while Shippo is
// still building it.
const catalog = type({
	data_availability: {
		"start?": "number | null",
		"end?": "number | null",
	},
});
// A finished run's file may not be ready to download yet, and its link
// expires; fetching the run again gives a fresh one.
const run = type({
	id: "string",
	status: "'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED'",
	"result?": type({
		"download?": type({ "status?": "string", "url?": "string" }).or("null"),
	}).or("null"),
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

// How the import reaches Shippo; tests stand in for it.
export type ReportApi = {
	get: (path: string) => Promise<unknown>;
	post: (path: string, body: unknown) => Promise<unknown>;
	download: (url: string) => Promise<Response>;
	sleep: (ms: number) => Promise<void>;
};

const live: ReportApi = {
	get: shippoGet,
	post: shippo,
	download: (url) => fetch(url),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Shippo's re-bills over the last 92 days its reports cover, or as many as
// it has. Until the file comes down, the run is asked again: still running,
// its file not ready, or a link that expired (a run asked for twice comes
// back finished, with the link it had). All within two minutes.
export async function fetchShippoRebills(
	api: ReportApi = live,
): Promise<ShippoRebill[]> {
	const { data_availability: covers } = catalog.assert(
		await api.get("/v2/reporting/reports/invoice.v1"),
	);
	const end = covers.end;
	if (end == null) return [];
	const start = Math.max(covers.start ?? 0, end - BACK_MS / 1000);
	if (start >= end) return [];
	let r = run.assert(
		await api.post("/v2/reporting/runs", {
			report_type: "invoice.v1",
			interval: { start, end },
			columns: COLUMNS,
			output_format: "csv_gzip",
			// The same window twice is the same report.
			idempotency_key: `katasync-rebills-${start}-${end}`,
		}),
	);
	const until = Date.now() + WAIT_MS;
	let failedDownload = "";
	for (;;) {
		if (r.status === "FAILED")
			throw new Error(
				`Shippo's invoice report failed: ${JSON.stringify(r.error)}`,
			);
		const url = r.status === "SUCCEEDED" ? r.result?.download?.url : undefined;
		if (url) {
			const file = await api.download(url);
			if (file.ok)
				return readRebills(
					gunzipSync(Buffer.from(await file.arrayBuffer())).toString("utf8"),
				);
			failedDownload = ` (its download answered ${file.status})`;
		}
		if (Date.now() > until)
			throw new Error(
				`Shippo's invoice report didn't come through in time${failedDownload}; next time`,
			);
		await api.sleep(POLL_MS);
		r = run.assert(await api.get(`/v2/reporting/runs/${r.id}`));
	}
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
	const touched = [...new Set(rows.map((r) => r.shipmentId))];
	// One transaction with the alert: re-bills saved without it would read as
	// already counted on the next run, and the label's alert never comes.
	await db.transaction(async (tx) => {
		const before = await rebilledOn(tx, touched);
		if (rows.length > 0)
			await tx
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
		const after = await rebilledOn(tx, touched);
		for (const id of touched) {
			const now = after.get(id);
			if (!now || !crossesLarge(before.get(id)?.amount ?? 0, now.amount))
				continue;
			await alertRebill(tx, {
				key: `shipment:${id}`,
				orderId: now.orderId,
				orderName: now.orderName,
				market: now.market,
				marketplaceId: now.marketplaceOrderId?.split(":")[1] ?? null,
				amount: now.amount,
				label: now.label,
				reasons: await reasonsFor(tx, id),
			});
		}
	});
	return {
		rebills: rebills.length,
		saved: rows.length,
		elsewhere: rebills.filter((r) => !byTransaction.has(r.transactionId))
			.length,
	};
}

// What was re-billed on each label, with the label's cost and the first of
// its orders, for the inbox's alert.
async function rebilledOn(db: Db, shipmentIds: number[]) {
	if (shipmentIds.length === 0) return new Map();
	const rows = await db
		.selectDistinctOn([shipments.id], {
			shipmentId: shipments.id,
			label: shipments.cost,
			amount: sql<number>`(select coalesce(sum(${shipmentAdjustments.amount}), 0)::float8
				from ${shipmentAdjustments} where ${shipmentAdjustments.shipmentId} = ${shipments.id})`,
			orderId: orders.id,
			orderName: orders.name,
			market: stores.channel,
			marketplaceOrderId: orders.marketplaceOrderId,
		})
		.from(shipments)
		.innerJoin(
			dispatchOrders,
			eq(dispatchOrders.dispatchId, shipments.dispatchId),
		)
		.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(inArray(shipments.id, shipmentIds))
		.orderBy(shipments.id, orders.id);
	return new Map(rows.map((r) => [r.shipmentId, r]));
}

// Why a label was re-billed, a line per item, for the inbox's alert.
async function reasonsFor(db: Db, shipmentId: number) {
	const items = await db
		.select({
			description: shipmentAdjustments.description,
			amount: shipmentAdjustments.amount,
		})
		.from(shipmentAdjustments)
		.where(eq(shipmentAdjustments.shipmentId, shipmentId))
		.orderBy(shipmentAdjustments.postedAt, shipmentAdjustments.id);
	return items.map(
		(i) =>
			`${describeRebill(rebillReason(i.description))}: ${formatMoney(i.amount)}`,
	);
}

export async function importShippoRebills(db: Db) {
	return saveShippoRebills(db, await fetchShippoRebills());
}
