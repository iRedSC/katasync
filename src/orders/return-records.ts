import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	returnRequestMedia,
	returnRequestRecords,
	returnRequests,
} from "#/db/schema";

// A return's history as the marketplace keeps it (TikTok's return records),
// with the photos and videos on each entry, saved over each time it's read.
// A picture is the return's, not its record's: a read that leaves it out
// moves it off the records, and a copy kept is never lost.

// Whether the picture is here. saved: it was kept on an earlier read, so it
// isn't downloaded again; the save leaves the kept copy as it is. failedFetches
// counts the fresh links that didn't download, so one refusal isn't taken
// for an expired picture (FETCHES_BEFORE_GONE).
export type MediaCopy =
	| { copy: "kept"; contentType: string; data: Buffer }
	| { copy: "saved" }
	| { copy: "unfetched" | "gone"; failedFetches: number }
	| { copy: "refused" };

export const FETCHES_BEFORE_GONE = 3;

// What a picture was when last saved, by its source key.
export type PriorPicture = {
	copy: (typeof returnRequestMedia.$inferSelect)["copy"];
	failedFetches: number;
};

// url is null when the link isn't on TikTok's media hosts: never fetched,
// and never opened from here.
export type RecordMedia =
	| ({
			kind: "image";
			url: string | null;
			sourceKey: string;
			width: number | null;
			height: number | null;
	  } & MediaCopy)
	| ({
			kind: "video";
			url: string | null;
			sourceKey: string;
			width: number | null;
			height: number | null;
			durationMs: number | null;
	  } & (
			| ({ coverUrl: string } & MediaCopy)
			// Nothing to keep without a cover; the video stays a link.
			| { coverUrl: null; copy: "none" }
	  ));

export type ReturnRecord = {
	role: string | null;
	event: string | null;
	description: string | null;
	reasonText: string | null;
	note: string | null;
	createdAt: Date | null;
	media: RecordMedia[];
};

// These returns' pictures as last saved, by source key.
export async function priorPictures(db: Db, requestIds: number[]) {
	const prior = new Map<number, Map<string, PriorPicture>>();
	if (requestIds.length === 0) return prior;
	const rows = await db
		.select({
			requestId: returnRequestMedia.requestId,
			sourceKey: returnRequestMedia.sourceKey,
			copy: returnRequestMedia.copy,
			failedFetches: returnRequestMedia.failedFetches,
		})
		.from(returnRequestMedia)
		.where(inArray(returnRequestMedia.requestId, requestIds));
	for (const { requestId, sourceKey, ...picture } of rows) {
		const keys = prior.get(requestId) ?? new Map();
		keys.set(sourceKey, picture);
		prior.set(requestId, keys);
	}
	return prior;
}

// Saves a return's records over the last read's, by position, and their
// pictures by source key. A picture this read leaves out stays, on no
// record; one shown twice stays where it's first shown. A kept copy is
// never written over by a read that didn't download it.
export async function saveRecords(
	tx: Db,
	requestId: number,
	records: ReturnRecord[],
) {
	// Off their places first, so a picture can move to one another had.
	await tx
		.update(returnRequestMedia)
		.set({ recordId: null, position: null })
		.where(eq(returnRequestMedia.requestId, requestId));
	await tx
		.delete(returnRequestRecords)
		.where(
			and(
				eq(returnRequestRecords.requestId, requestId),
				gte(returnRequestRecords.position, records.length),
			),
		);
	const placed = new Set<string>();
	for (const [position, r] of records.entries()) {
		const record = {
			requestId,
			position,
			role: r.role,
			event: r.event,
			description: r.description,
			reasonText: r.reasonText,
			note: r.note,
			createdAt: r.createdAt,
		};
		const [row] = await tx
			.insert(returnRequestRecords)
			.values(record)
			.onConflictDoUpdate({
				target: [returnRequestRecords.requestId, returnRequestRecords.position],
				set: record,
			})
			.returning({ id: returnRequestRecords.id });
		for (const [i, m] of r.media.entries()) {
			if (placed.has(m.sourceKey)) continue;
			placed.add(m.sourceKey);
			const values = {
				requestId,
				recordId: row.id,
				position: i,
				kind: m.kind,
				url: m.url,
				coverUrl: m.kind === "video" ? m.coverUrl : null,
				sourceKey: m.sourceKey,
				width: m.width,
				height: m.height,
				durationMs: m.kind === "video" ? m.durationMs : null,
				...copyOf(m),
			};
			const keeps = sql`${returnRequestMedia.copy} = 'kept' and excluded.copy <> 'kept'`;
			await tx
				.insert(returnRequestMedia)
				.values(values)
				.onConflictDoUpdate({
					target: [returnRequestMedia.requestId, returnRequestMedia.sourceKey],
					set: {
						...values,
						copy: sql`case when ${keeps} then ${returnRequestMedia.copy} else excluded.copy end`,
						failedFetches: sql`case when ${keeps} then 0 else excluded.failed_fetches end`,
						contentType: sql`case when ${keeps} then ${returnRequestMedia.contentType} else excluded.content_type end`,
						data: sql`case when ${keeps} then ${returnRequestMedia.data} else excluded.data end`,
					},
				});
		}
	}
}

// A picture read as saved is written as unfetched: the save keeps the copy
// already there, and one that somehow isn't is downloaded next read.
function copyOf(m: RecordMedia) {
	switch (m.copy) {
		case "kept":
			return {
				copy: "kept" as const,
				failedFetches: 0,
				contentType: m.contentType,
				data: m.data,
			};
		case "saved":
			return {
				copy: "unfetched" as const,
				failedFetches: 0,
				contentType: null,
				data: null,
			};
		case "unfetched":
		case "gone":
			return {
				copy: m.copy,
				failedFetches: m.failedFetches,
				contentType: null,
				data: null,
			};
		case "refused":
		case "none":
			return { copy: m.copy, failedFetches: 0, contentType: null, data: null };
	}
}

// What the buyer wrote when asking: the first note of theirs.
export function buyerNote(records: ReturnRecord[]) {
	return (
		records.find((r) => r.role === "BUYER" && r.note?.trim())?.note?.trim() ??
		null
	);
}

// A read whose pictures didn't all download is read again, with fresh
// links, until they do.
export const recordsComplete = (records: ReturnRecord[]) =>
	records.every((r) => r.media.every((m) => m.copy !== "unfetched"));

// An order's return records as its page shows them, by return request,
// with each picture's copy named but not its bytes (served on their own, by
// /api/return-media/$mediaId). unlisted: pictures the last read no longer
// showed on any record, kept all the same.
export async function orderRecords(db: Db, orderId: number) {
	const rows = await db
		.select({
			id: returnRequestRecords.id,
			requestId: returnRequestRecords.requestId,
			role: returnRequestRecords.role,
			event: returnRequestRecords.event,
			description: returnRequestRecords.description,
			reasonText: returnRequestRecords.reasonText,
			note: returnRequestRecords.note,
			createdAt: returnRequestRecords.createdAt,
		})
		.from(returnRequestRecords)
		.innerJoin(
			returnRequests,
			eq(returnRequests.id, returnRequestRecords.requestId),
		)
		.where(eq(returnRequests.orderId, orderId))
		.orderBy(returnRequestRecords.requestId, returnRequestRecords.position);
	const media = await db
		.select({
			id: returnRequestMedia.id,
			requestId: returnRequestMedia.requestId,
			recordId: returnRequestMedia.recordId,
			kind: returnRequestMedia.kind,
			url: returnRequestMedia.url,
			copy: returnRequestMedia.copy,
		})
		.from(returnRequestMedia)
		.innerJoin(
			returnRequests,
			eq(returnRequests.id, returnRequestMedia.requestId),
		)
		.where(eq(returnRequests.orderId, orderId))
		.orderBy(returnRequestMedia.recordId, returnRequestMedia.position);
	type Media = Omit<(typeof media)[number], "requestId" | "recordId">;
	const byRequest = new Map<
		number,
		{
			records: ((typeof rows)[number] & { media: Media[] })[];
			unlisted: Media[];
		}
	>();
	const of = (requestId: number) => {
		const found = byRequest.get(requestId) ?? { records: [], unlisted: [] };
		byRequest.set(requestId, found);
		return found;
	};
	const strip = ({
		requestId: _,
		recordId: __,
		...m
	}: (typeof media)[number]) => m;
	for (const r of rows)
		of(r.requestId).records.push({
			...r,
			media: media.filter((m) => m.recordId === r.id).map(strip),
		});
	for (const m of media)
		if (m.recordId === null) of(m.requestId).unlisted.push(strip(m));
	return byRequest;
}

// A kept picture, for the browser.
export async function recordPicture(db: Db, mediaId: number) {
	const [row] = await db
		.select({
			kind: returnRequestMedia.kind,
			contentType: returnRequestMedia.contentType,
			data: returnRequestMedia.data,
		})
		.from(returnRequestMedia)
		.where(eq(returnRequestMedia.id, mediaId));
	if (!row?.data || !row.contentType) return null;
	const extension = row.contentType.split("/")[1] ?? "jpeg";
	return {
		filename: `return-${row.kind}-${mediaId}.${extension}`,
		contentType: row.contentType,
		data: row.data,
	};
}
