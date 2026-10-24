import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	reportArtifacts,
	reportHandoffs,
	reportSnapshots,
} from "#/db/report-schema";
import { profitTotals } from "#/orders/profit";
import {
	type Period,
	periodText,
	periodWindow,
	readSalesReport,
} from "#/orders/sales-report";
import { readEvidence } from "./evidence";
import { aboutFile, CSV_FILES, csvFile, type RevisionMeta } from "./files";
import { printHtml } from "./print-html";
import {
	canonicalJson,
	parseReportData,
	RENDERER_VERSION,
	type ReportData,
	SCHEMA_VERSION,
	toReportData,
} from "./snapshot";

export const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

export const dataDigestOf = (data: ReportData) => sha256(canonicalJson(data));

export async function readReport(tx: Db, period: Period) {
	const window = await periodWindow(tx, period);
	const [sales, totals, evidence] = await Promise.all([
		readSalesReport(tx, period),
		profitTotals(tx, window.start, window.end),
		readEvidence(tx, window),
	]);
	const data = toReportData({ period, window, sales, totals, evidence });
	return { sales, data, dataDigest: dataDigestOf(data) };
}

export type Artifact = { name: string; mediaType: string; content: string };

export function renderArtifacts(
	data: ReportData,
	meta: RevisionMeta,
): Artifact[] {
	return [
		{
			name: "report.html",
			mediaType: "text/html; charset=utf-8",
			content: printHtml(data, meta),
		},
		{
			name: "about.csv",
			mediaType: "text/csv; charset=utf-8",
			content: aboutFile(data, meta),
		},
		...CSV_FILES.map((file) => ({
			name: `${file}.csv`,
			mediaType: "text/csv; charset=utf-8",
			content: csvFile(data, file),
		})),
	];
}

export function revisionDigest(input: {
	period: string;
	revision: number;
	asOf: string;
	dataDigest: string;
	files: { name: string; sha256: string }[];
}) {
	return sha256(
		canonicalJson({
			kind: "sales_tax_month",
			schemaVersion: SCHEMA_VERSION,
			rendererVersion: RENDERER_VERSION,
			...input,
			files: [...input.files].sort((a, b) => (a.name < b.name ? -1 : 1)),
		}),
	);
}

export type SaveResult =
	| { kind: "saved"; id: number; revision: number; digest: string }
	| { kind: "unchanged"; id: number; revision: number; digest: string };

const CONFLICTS = new Set(["23505", "40001"]);
function pgCode(e: unknown): string | undefined {
	for (
		let x = e;
		x && typeof x === "object";
		x = (x as { cause?: unknown }).cause
	)
		if ("code" in x && typeof x.code === "string") return x.code;
	return undefined;
}

const latestOf = (tx: Db, period: string) =>
	tx
		.select()
		.from(reportSnapshots)
		.where(
			and(
				eq(reportSnapshots.kind, "sales_tax_month"),
				eq(reportSnapshots.period, period),
			),
		)
		.orderBy(desc(reportSnapshots.revision))
		.limit(1);

async function saveOnce(db: Db, period: Period): Promise<SaveResult> {
	return db.transaction(
		async (tx) => {
			const {
				rows: [{ asOf }],
			} = (await tx.execute(
				sql`select (to_json(now() at time zone 'UTC') #>> '{}') || 'Z' as "asOf"`,
			)) as unknown as { rows: { asOf: string }[] };
			const { data, dataDigest } = await readReport(tx, period);
			const text = periodText(period);
			const [latest] = await latestOf(tx, text);
			if (latest?.dataDigest === dataDigest)
				return {
					kind: "unchanged" as const,
					id: latest.id,
					revision: latest.revision,
					digest: latest.digest,
				};
			const revision = (latest?.revision ?? 0) + 1;
			const meta = { revision, asOf, dataDigest };
			const files = renderArtifacts(data, meta).map((f) => ({
				...f,
				sha256: sha256(f.content),
			}));
			const digest = revisionDigest({ period: text, ...meta, files });
			const [row] = await tx
				.insert(reportSnapshots)
				.values({
					kind: "sales_tax_month",
					period: text,
					revision,
					asOf: sql`now()`,
					schemaVersion: SCHEMA_VERSION,
					rendererVersion: RENDERER_VERSION,
					currency: data.currency,
					timeZone: data.timeZone,
					source: data.source,
					data,
					dataDigest,
					digest,
				})
				.returning({ id: reportSnapshots.id });
			await tx
				.insert(reportArtifacts)
				.values(files.map((f) => ({ snapshotId: row.id, ...f })));
			return { kind: "saved" as const, id: row.id, revision, digest };
		},
		{ isolationLevel: "repeatable read", accessMode: "read write" },
	);
}

export async function saveRevision(
	db: Db,
	period: Period,
	attempts = 3,
): Promise<SaveResult> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await saveOnce(db, period);
		} catch (e) {
			const code = pgCode(e);
			if (attempt >= attempts || !code || !CONFLICTS.has(code)) throw e;
		}
	}
}

export type Handoff = {
	recipient: string;
	note: string | null;
	handedAt: Date;
};

export type RevisionView = {
	id: number;
	revision: number;
	asOf: Date;
	digest: string;
	dataDigest: string;
	schemaVersion: number;
	rendererVersion: number;
	currency: string;
	timeZone: string;
	data: ReportData;
	files: { name: string; sha256: string; bytes: number }[];
	handoffs: Handoff[];
	state: { kind: "current" } | { kind: "superseded"; by: number };
};

export async function listRevisions(
	db: Db,
	period: Period,
): Promise<RevisionView[]> {
	const rows = await db
		.select()
		.from(reportSnapshots)
		.where(
			and(
				eq(reportSnapshots.kind, "sales_tax_month"),
				eq(reportSnapshots.period, periodText(period)),
			),
		)
		.orderBy(desc(reportSnapshots.revision));
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const [files, handoffs] = await Promise.all([
		db
			.select({
				snapshotId: reportArtifacts.snapshotId,
				name: reportArtifacts.name,
				sha256: reportArtifacts.sha256,
				bytes: sql<number>`octet_length(${reportArtifacts.content})::int`,
			})
			.from(reportArtifacts)
			.where(inArray(reportArtifacts.snapshotId, ids))
			.orderBy(asc(reportArtifacts.name)),
		db
			.select()
			.from(reportHandoffs)
			.where(inArray(reportHandoffs.snapshotId, ids))
			.orderBy(asc(reportHandoffs.handedAt), asc(reportHandoffs.id)),
	]);
	const latest = rows[0].revision;
	return rows.map((r) => ({
		id: r.id,
		revision: r.revision,
		asOf: r.asOf,
		digest: r.digest,
		dataDigest: r.dataDigest,
		schemaVersion: r.schemaVersion,
		rendererVersion: r.rendererVersion,
		currency: r.currency,
		timeZone: r.timeZone,
		data: parseReportData(r.data),
		files: files
			.filter((f) => f.snapshotId === r.id)
			.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
		handoffs: handoffs
			.filter((h) => h.snapshotId === r.id)
			.map(({ recipient, note, handedAt }) => ({ recipient, note, handedAt })),
		state:
			r.revision === latest
				? { kind: "current" as const }
				: { kind: "superseded" as const, by: latest },
	}));
}

export type LiveState =
	| { kind: "unsaved" }
	| { kind: "saved"; revision: number }
	| { kind: "changed"; since: number; handedOff: boolean };

export function liveState(
	dataDigest: string,
	revisions: RevisionView[],
): LiveState {
	const [latest] = revisions;
	if (!latest) return { kind: "unsaved" };
	if (latest.dataDigest === dataDigest)
		return { kind: "saved", revision: latest.revision };
	return {
		kind: "changed",
		since: latest.revision,
		handedOff: revisions.some((r) => r.handoffs.length > 0),
	};
}

export function reportPage(db: Db, period: Period) {
	return db.transaction(
		async (tx) => {
			const { sales, data, dataDigest } = await readReport(tx, period);
			const revisions = await listRevisions(tx, period);
			return {
				...sales,
				live: { data, dataDigest },
				revisions,
				liveState: liveState(dataDigest, revisions),
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

export async function readArtifact(
	db: Db,
	{ snapshotId, name }: { snapshotId: number; name: string },
) {
	const [row] = await db
		.select({
			name: reportArtifacts.name,
			mediaType: reportArtifacts.mediaType,
			content: reportArtifacts.content,
			sha256: reportArtifacts.sha256,
			period: reportSnapshots.period,
			revision: reportSnapshots.revision,
			digest: reportSnapshots.digest,
		})
		.from(reportArtifacts)
		.innerJoin(
			reportSnapshots,
			eq(reportSnapshots.id, reportArtifacts.snapshotId),
		)
		.where(
			and(
				eq(reportArtifacts.snapshotId, snapshotId),
				eq(reportArtifacts.name, name),
			),
		);
	if (!row) throw new Error(`No ${name} in that revision`);
	if (sha256(row.content) !== row.sha256)
		throw new Error(`${name} no longer matches its digest`);
	const dot = row.name.lastIndexOf(".");
	return {
		...row,
		filename: `${row.name.slice(0, dot)}-${row.period}-r${row.revision}${row.name.slice(dot)}`,
	};
}

export async function handOff(
	db: Db,
	input: {
		snapshotId: number;
		digest: string;
		recipient: string;
		note?: string | null;
	},
) {
	const recipient = input.recipient.trim();
	if (!recipient) throw new Error("Say who it went to");
	try {
		const [row] = await db
			.insert(reportHandoffs)
			.values({
				snapshotId: input.snapshotId,
				digest: input.digest,
				recipient,
				note: input.note?.trim() || null,
			})
			.returning();
		return row;
	} catch (e) {
		if (pgCode(e) === "23503")
			throw new Error("That revision's digest doesn't match what was saved");
		throw e;
	}
}
