import { gunzipSync } from "node:zlib";
import { type } from "arktype";
import { MARKETPLACE_US, spApi } from "./amazon-api";

// Amazon builds reports in the background: a pass asks for one, and imports
// it once it's ready, that pass or a later one.
const REPORTS = "/reports/2021-06-30";
// How long a pass waits for a report it asked for. Amazon usually takes
// under a minute; one that takes longer is imported next pass.
const WAIT_MS = 90 * 1000;

const reportsPage = type({
	reports: type({
		reportId: "string",
		processingStatus: "string",
		createdTime: "string.date.iso.parse",
		"dataEndTime?": "string.date.iso.parse",
		"reportDocumentId?": "string",
	}).array(),
});
const report = reportsPage.get("reports").get(0);
export type Report = typeof report.infer;
const reportDocument = type({
	url: "string",
	"compressionAlgorithm?": "string",
});

// The newest reports of this type, newest first, done or still being built.
export async function listReports(
	reportType: string,
	pageSize = 1,
): Promise<Report[]> {
	return reportsPage.assert(
		await spApi(
			`${REPORTS}/reports?reportTypes=${reportType}&marketplaceIds=${MARKETPLACE_US}&processingStatuses=IN_QUEUE,IN_PROGRESS,DONE&pageSize=${pageSize}`,
		),
	).reports;
}

// The newest report of this type, asking for a new one if that's older than
// freshMs. Its text, or null while it's still being built.
export async function latestReport(
	reportType: string,
	options: { freshMs: number; now?: number },
): Promise<string | null> {
	let [latest] = await listReports(reportType);
	const now = options.now ?? Date.now();
	if (!latest || now - latest.createdTime.getTime() >= options.freshMs) {
		latest = await requestReport(reportType);
	}
	return reportText(latest);
}

// Asks for a new report and waits for it, up to waitMs.
export async function requestReport(
	reportType: string,
	body: Record<string, unknown> = {},
	waitMs = WAIT_MS,
): Promise<Report> {
	const { reportId } = type({ reportId: "string" }).assert(
		await spApi(`${REPORTS}/reports`, {
			reportType,
			marketplaceIds: [MARKETPLACE_US],
			...body,
		}),
	);
	return waitForReport(reportId, waitMs);
}

// The report once Amazon is done with it, or as it stands after waitMs.
export async function waitForReport(
	reportId: string,
	waitMs = WAIT_MS,
): Promise<Report> {
	const until = Date.now() + waitMs;
	for (;;) {
		const found = report.assert(await spApi(`${REPORTS}/reports/${reportId}`));
		if (
			found.processingStatus !== "IN_QUEUE" &&
			found.processingStatus !== "IN_PROGRESS"
		)
			return found;
		if (Date.now() > until) return found;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
}

// A finished report's text, or null if it isn't done. Amazon ends a report
// it had nothing for CANCELLED; that's null here too, since for some reports
// (listings) nothing means something went wrong.
export async function reportText(found: Report): Promise<string | null> {
	if (found.processingStatus !== "DONE" || !found.reportDocumentId) return null;
	const doc = reportDocument.assert(
		await spApi(`${REPORTS}/documents/${found.reportDocumentId}`),
	);
	const response = await fetch(doc.url);
	if (!response.ok) throw new Error(`Amazon's report: ${response.status}`);
	let bytes = Buffer.from(await response.arrayBuffer());
	if (doc.compressionAlgorithm === "GZIP") bytes = gunzipSync(bytes);
	return bytes.toString("utf8");
}

// A tab-separated report's rows, keyed by its header row's names. Throws
// naming the first expected column it lacks, so a renamed column fails
// loudly instead of reading as blank.
export function parseTsv(
	text: string,
	expected: readonly string[],
	name: string,
): Record<string, string>[] {
	const [header = "", ...rows] = text.replace(/^﻿/, "").split(/\r?\n/);
	const columns = header.split("\t").map((c) => c.trim());
	for (const column of expected) {
		if (!columns.includes(column))
			throw new Error(`Amazon's ${name} report has no ${column}`);
	}
	return rows
		.filter((row) => row.trim() !== "")
		.map((row) => {
			const cells = row.split("\t");
			return Object.fromEntries(
				columns.map((c, i) => [c, cells[i]?.trim() ?? ""]),
			);
		});
}
