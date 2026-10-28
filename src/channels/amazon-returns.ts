import type { ChannelReturn } from "#/orders/return-requests";
import {
	listReports,
	parseTsv,
	type Report,
	reportText,
	requestReport,
	waitForReport,
} from "./amazon-reports";
import {
	evidenceColumns,
	requestEvidence,
	rowEvidence,
} from "./amazon-return-evidence";
import { amazonReturnStage } from "./marketplace-case-stage";

// Returns buyers opened on orders we shipped ourselves, with Amazon's reason,
// from its returns report (amazon-reports.ts). Needs the SP-API Inventory and
// Order Tracking role. FBA returns and refunds without a return aren't in it.
const REPORT = "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE";
// The most one report may cover.
export const REPORT_DAYS = 60;
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

// Amazon's own wording, read as a stage. Its statuses don't say whether the
// box arrived, so the delivery date and tracking do.
export function returnStatus(row: {
	status: string;
	delivered: boolean;
	tracked: boolean;
}): ChannelReturn["status"] {
	return amazonReturnStage(row).status;
}

// One row per item returned; a return of several items shares its RMA ID,
// and each item keeps its own reason and status. Rows Amazon left without a
// usable date or quantity are skipped and named.
export function parseReturnsReport(text: string): {
	returns: ChannelReturn[];
	problems: string[];
} {
	const byRma = new Map<string, Row[]>();
	const problems: string[] = [];
	const rows = parseTsv(text, COLUMNS, "returns");
	for (const row of rows) {
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
		byRma.set(rmaId, [...(byRma.get(rmaId) ?? []), { row, quantity }]);
	}
	const { cells, missing } = evidenceColumns(Object.keys(rows[0] ?? {}));
	if (rows.length > 0 && missing.length > 0)
		problems.push(`Amazon's returns report has no ${missing.join(", ")}`);
	const returns = [...byRma].map(([rmaId, items]): ChannelReturn => {
		const [{ row }] = items;
		const said = { of: `Amazon return ${rmaId}`, list: problems };
		const { refunded, ...evidence } = requestEvidence(
			items.map((i) =>
				rowEvidence(cells(i.row), i.row["Return delivery date"], said),
			),
		);
		const trackingNumber =
			items.map((i) => i.row["Tracking ID"]).find(Boolean) ?? null;
		return {
			externalId: rmaId,
			orderExternalId: row["Order ID"],
			rawStatus: row["Return request status"],
			...amazonReturnStage({
				status: row["Return request status"],
				delivered: items.some((i) => i.row["Return delivery date"] !== ""),
				tracked: trackingNumber !== null,
				aToZClaim: evidence.aToZClaim === true,
			}),
			// Only what Amazon says it refunded, never worked out here; left
			// out when this report can't say.
			...(refunded === undefined
				? {}
				: (refunded ?? { amount: null, currency: null })),
			nextAction: null,
			caseRef: null,
			reason: row["Return Reason"] || null,
			// Amazon's report has no buyer comments.
			note: null,
			trackingNumber,
			carrier: items.map((i) => i.row["Return carrier"]).find(Boolean) ?? null,
			requestedAt: new Date(row["Return request date"]),
			evidence,
			lines: items.map((i) => ({
				lineExternalId: i.row["Order Item ID"] || null,
				sku: i.row["Merchant SKU"] || null,
				quantity: i.quantity,
				reason: i.row["Return Reason"] || null,
				rawStatus: i.row["Return request status"] || null,
			})),
		};
	});
	return { returns, problems: [...new Set(problems)] };
}

type Row = { row: Record<string, string>; quantity: number };

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

// Returns requested from `from` (no more than 60 days back) up to about
// now, with the stretch the report really covers. A report a recent pass
// asked for is read instead of asking again, but only when Amazon says it
// covers that start, so passes don't each ask for their own and a reused
// one never stands in for days it doesn't hold. Null while it's being built.
export async function recentAmazonReturns(from: Date, now = Date.now()) {
	const recent = (await listReports(REPORT, 10)).find(
		(r) =>
			now - r.createdTime.getTime() < FRESH_MS &&
			r.dataStartTime !== undefined &&
			r.dataStartTime <= from &&
			r.dataEndTime !== undefined &&
			r.createdTime.getTime() - r.dataEndTime.getTime() < 60 * 60 * 1000,
	);
	const found = recent
		? await waitForReport(recent.reportId)
		: await requestReport(REPORT, {
				dataStartTime: from.toISOString(),
				dataEndTime: new Date(now).toISOString(),
			});
	const read = await readReport(found);
	if (!read) return null;
	return {
		...read,
		from: found.dataStartTime ?? from,
		until: found.dataEndTime ?? new Date(found.createdTime),
	};
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
