import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	returnRequestLines,
	returnRequests,
} from "#/db/schema";
import {
	listReports,
	parseTsv,
	type Report,
	reportText,
	requestReport,
	waitForReport,
} from "./amazon-reports";

// Returns buyers opened on orders we shipped ourselves, with Amazon's reason,
// from its returns report (amazon-reports.ts). Needs the SP-API Inventory and
// Order Tracking role. FBA returns and refunds without a return aren't in it.
const REPORT = "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE";
// The most one report may cover.
export const REPORT_DAYS = 60;
const DAY = 24 * 60 * 60 * 1000;
// A recent-returns report younger than this is current enough.
const FRESH_MS = 25 * 60 * 1000;

const COLUMNS = [
	"Order ID",
	"Return request date",
	"Return request status",
	"Amazon RMA ID",
	"Tracking ID",
	"Return carrier",
	"Merchant SKU",
	"Return quantity",
	"Return Reason",
	"Return delivery date",
	"Order Item ID",
] as const;

export type AmazonReturn = {
	rmaId: string;
	orderId: string;
	rawStatus: string;
	status: (typeof returnRequests.$inferInsert)["status"];
	reason: string | null;
	trackingNumber: string | null;
	carrier: string | null;
	requestedAt: Date;
	lines: { orderItemId: string | null; sku: string | null; quantity: number }[];
};

// Amazon's own wording, read as a stage. Its statuses don't say whether the
// box arrived, so the delivery date and tracking do.
export function returnStatus(row: {
	status: string;
	delivered: boolean;
	tracked: boolean;
}): AmazonReturn["status"] {
	const s = row.status.toLowerCase();
	if (s.includes("cancel") || s.includes("reject")) return "cancelled";
	if (s.includes("closed")) return "closed";
	if (row.delivered) return "delivered";
	if (row.tracked) return "shipped";
	return "requested";
}

// One row per item returned; a return of several items shares its RMA ID.
// Rows Amazon left without a usable date or quantity are skipped and named.
export function parseReturnsReport(text: string): {
	returns: AmazonReturn[];
	problems: string[];
} {
	const byRma = new Map<string, AmazonReturn>();
	const problems: string[] = [];
	for (const row of parseTsv(text, COLUMNS, "returns")) {
		const orderId = row["Order ID"];
		const requestedAt = new Date(row["Return request date"]);
		const quantity = Number(row["Return quantity"]);
		if (!orderId || Number.isNaN(requestedAt.getTime())) {
			problems.push(`Amazon return for ${orderId || "no order"} has no date`);
			continue;
		}
		if (!Number.isInteger(quantity) || quantity <= 0) {
			problems.push(`Amazon return for ${orderId} has no quantity`);
			continue;
		}
		// Without an RMA, each item stands alone.
		const rmaId =
			row["Amazon RMA ID"] ||
			`${orderId}:${row["Order Item ID"]}:${row["Return request date"]}`;
		const found = byRma.get(rmaId) ?? {
			rmaId,
			orderId,
			rawStatus: row["Return request status"],
			status: returnStatus({
				status: row["Return request status"],
				delivered: row["Return delivery date"] !== "",
				tracked: row["Tracking ID"] !== "",
			}),
			reason: row["Return Reason"] || null,
			trackingNumber: row["Tracking ID"] || null,
			carrier: row["Return carrier"] || null,
			requestedAt,
			lines: [],
		};
		found.lines.push({
			orderItemId: row["Order Item ID"] || null,
			sku: row["Merchant SKU"] || null,
			quantity,
		});
		byRma.set(rmaId, found);
	}
	return { returns: [...byRma.values()], problems };
}

// Saves each return against its order, replacing what Amazon said before.
// A return for an order katasync doesn't have (older than its history, or
// never synced) is skipped and counted. Lines match by Amazon's order item
// ID, then by SKU.
export async function saveAmazonReturns(
	db: Db,
	storeId: number,
	returns: AmazonReturn[],
): Promise<{ saved: number; skipped: number }> {
	if (returns.length === 0) return { saved: 0, skipped: 0 };
	const known = await db
		.select({ id: orders.id, externalId: orders.externalId })
		.from(orders)
		.where(
			and(
				eq(orders.storeId, storeId),
				inArray(orders.externalId, [...new Set(returns.map((r) => r.orderId))]),
			),
		);
	const orderIds = new Map(known.map((o) => [o.externalId, o.id]));
	let saved = 0;
	for (const r of returns) {
		const orderId = orderIds.get(r.orderId);
		if (orderId === undefined) continue;
		await db.transaction(async (tx) => {
			const lines = await tx
				.select({
					id: orderLines.id,
					externalId: orderLines.externalId,
					sku: orderLines.sku,
				})
				.from(orderLines)
				.where(eq(orderLines.orderId, orderId));
			const values = {
				orderId,
				billedBy: "amazon" as const,
				externalId: r.rmaId,
				status: r.status,
				rawStatus: r.rawStatus,
				reason: r.reason,
				trackingNumber: r.trackingNumber,
				carrier: r.carrier,
				requestedAt: r.requestedAt,
				sourceUpdatedAt: new Date(),
			};
			const [request] = await tx
				.insert(returnRequests)
				.values(values)
				.onConflictDoUpdate({
					target: [returnRequests.billedBy, returnRequests.externalId],
					set: { ...values, syncedAt: sql`now()` },
				})
				.returning({ id: returnRequests.id });
			await tx
				.delete(returnRequestLines)
				.where(eq(returnRequestLines.requestId, request.id));
			await tx.insert(returnRequestLines).values(
				r.lines.map((l) => ({
					requestId: request.id,
					orderLineId:
						(
							lines.find(
								(o) => l.orderItemId && o.externalId === l.orderItemId,
							) ?? lines.find((o) => l.sku && o.sku === l.sku)
						)?.id ?? null,
					sku: l.sku,
					quantity: l.quantity,
				})),
			);
		});
		saved++;
	}
	return { saved, skipped: returns.length - saved };
}

// One window's returns, by when they were requested. Waits up to waitMs for
// Amazon to build the report; null if it isn't done by then.
export async function fetchAmazonReturns(
	from: Date,
	until: Date,
	waitMs?: number,
) {
	const found = await requestReport(
		REPORT,
		{ dataStartTime: from.toISOString(), dataEndTime: until.toISOString() },
		waitMs,
	);
	return readReport(found);
}

// Returns requested in the last 60 days, from a report a recent pass asked
// for if there is one, so passes don't each ask for their own. Older reports
// of this type (a history backfill's) cover other dates and are passed over.
export async function recentAmazonReturns(now = Date.now()) {
	const recent = (await listReports(REPORT, 10)).find(
		(r) =>
			now - r.createdTime.getTime() < FRESH_MS &&
			r.dataEndTime !== undefined &&
			r.createdTime.getTime() - r.dataEndTime.getTime() < 60 * 60 * 1000,
	);
	if (recent) return readReport(await waitForReport(recent.reportId));
	return fetchAmazonReturns(new Date(now - REPORT_DAYS * DAY), new Date(now));
}

// A report Amazon had nothing for ends CANCELLED: no returns, not a failure.
// One it couldn't build (FATAL) is, or every pass would wait on it quietly.
async function readReport(found: Report) {
	if (found.processingStatus === "CANCELLED")
		return { returns: [], problems: [] };
	if (found.processingStatus === "FATAL")
		throw new Error(
			`Amazon couldn't build its returns report ${found.reportId}`,
		);
	const text = await reportText(found);
	return text === null ? null : parseReturnsReport(text);
}
