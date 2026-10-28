import { type } from "arktype";
import { errorText } from "#/diagnostics/runs";
import {
	buyerNote,
	FETCHES_BEFORE_GONE,
	type MediaCopy,
	type PriorPicture,
	type RecordMedia,
	type ReturnRecord,
	recordsComplete,
} from "#/orders/return-records";
import type { ChannelReturn } from "#/orders/return-requests";
import { shopCipher, tiktokApi } from "./tiktok";

// A TikTok return's records: each step with who took it, in their words,
// and the photos and videos the buyer attached. TikTok's media links are
// signed (?shp=, ?shcp=) and its video links carry an expiry in their path,
// so photos and video covers are downloaded and kept; videos stay links.

const records = (id: string) => `/return_refund/202309/returns/${id}/records`;

const recordList = type({
	"records?": type({
		"role?": "string",
		"event?": "string",
		"description?": "string",
		"reason_text?": "string",
		"note?": "string",
		"create_time?": "number.integer >= 0",
		"images?": type({
			url: "string",
			"width?": "number.integer",
			"height?": "number.integer",
		}).array(),
		"videos?": type({
			url: "string",
			"cover?": "string",
			"width?": "number.integer",
			"height?": "number.integer",
			"duration_millis?": "number.integer",
		}).array(),
	}).array(),
});

// The same picture comes from p16- or p19- hosts with a new signature each
// read; its path names it.
export const sourceKey = (url: string) => {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
};

// TikTok's media hosts: ttcdn-us.com serves this shop's photos, and its
// docs show ibyteimg.com. Nothing else is fetched, redirects included, so a
// link in TikTok's data can't make katasync call anywhere else.
const MEDIA_HOSTS = [
	"ttcdn-us.com",
	"ibyteimg.com",
	"tiktokcdn-us.com",
	"tiktokcdn.com",
];

export function mediaHost(url: string) {
	try {
		const u = new URL(url);
		return (
			u.protocol === "https:" &&
			!u.username &&
			!u.password &&
			u.port === "" &&
			MEDIA_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
		);
	} catch {
		return false;
	}
}

export const MAX_PICTURE_BYTES = 10_000_000;
const PICTURE_SECONDS = 15;
const MAX_REDIRECTS = 3;

// One try at a picture. missing: TikTok says it isn't there (404, 410).
// failed: anything that might pass with a fresh link, a 403 included.
export type Fetched =
	| { kind: "kept"; contentType: string; data: Buffer }
	| { kind: "missing" }
	| { kind: "failed" }
	| { kind: "refused" };

export type Download = (url: string) => Promise<Fetched>;

export const downloadPicture: Download = async (url) => {
	const signal = AbortSignal.timeout(PICTURE_SECONDS * 1000);
	try {
		let at = url;
		for (let hop = 0; ; hop++) {
			if (!mediaHost(at)) return { kind: "refused" };
			const response = await fetch(at, { signal, redirect: "manual" });
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				if (!location || hop >= MAX_REDIRECTS) return { kind: "failed" };
				at = new URL(location, at).toString();
				continue;
			}
			if (response.status === 404 || response.status === 410) {
				await response.body?.cancel();
				return { kind: "missing" };
			}
			const contentType = response.headers.get("content-type") ?? "";
			const length = Number(response.headers.get("content-length") ?? 0);
			if (
				!response.ok ||
				!contentType.startsWith("image/") ||
				length > MAX_PICTURE_BYTES ||
				!response.body
			) {
				await response.body?.cancel();
				return { kind: "failed" };
			}
			const data = await capped(response.body);
			return data && data.length > 0
				? { kind: "kept", contentType, data }
				: { kind: "failed" };
		}
	} catch {
		return { kind: "failed" };
	}
};

// The body, or null once it passes the cap, read no further.
async function capped(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return Buffer.concat(chunks);
		size += value.length;
		if (size > MAX_PICTURE_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
}

// A link from TikTok's data as kept, to fetch or to open: null unless it's
// on TikTok's media hosts.
const tiktokLink = (url: string) => (mediaHost(url) ? url : null);

// A picture as this read leaves it. One kept before isn't downloaded again;
// one gone or refused isn't asked for again, nor one off TikTok's hosts.
async function picture(
	url: string,
	prior: Map<string, PriorPicture>,
	download: Download,
): Promise<MediaCopy> {
	if (!mediaHost(url)) return { copy: "refused" };
	const was = prior.get(sourceKey(url));
	switch (was?.copy) {
		case "kept":
			return { copy: "saved" };
		case "gone":
			return { copy: "gone", failedFetches: was.failedFetches };
		case "refused":
			return { copy: "refused" };
	}
	const got = await download(url);
	switch (got.kind) {
		case "kept":
			return { copy: "kept", contentType: got.contentType, data: got.data };
		case "missing":
			return { copy: "gone", failedFetches: (was?.failedFetches ?? 0) + 1 };
		case "refused":
			return { copy: "refused" };
		case "failed": {
			const failedFetches = (was?.failedFetches ?? 0) + 1;
			return failedFetches >= FETCHES_BEFORE_GONE
				? { copy: "gone", failedFetches }
				: { copy: "unfetched", failedFetches };
		}
	}
}

export async function returnRecords(
	cipher: string,
	returnId: string,
	prior: Map<string, PriorPicture>,
	download: Download = downloadPicture,
): Promise<ReturnRecord[]> {
	const found = recordList.assert(
		await tiktokApi(records(returnId), { shop_cipher: cipher }),
	);
	const read: ReturnRecord[] = [];
	for (const r of found.records ?? []) {
		const media: RecordMedia[] = [];
		for (const image of r.images ?? [])
			media.push({
				kind: "image",
				url: tiktokLink(image.url),
				sourceKey: sourceKey(image.url),
				width: image.width ?? null,
				height: image.height ?? null,
				...(await picture(image.url, prior, download)),
			});
		for (const video of r.videos ?? []) {
			const common = {
				kind: "video" as const,
				// The video is only ever a link, so it's checked on its own:
				// a cover on TikTok's hosts says nothing of where it points.
				url: tiktokLink(video.url),
				width: video.width ?? null,
				height: video.height ?? null,
				durationMs: video.duration_millis ?? null,
			};
			media.push(
				video.cover
					? {
							...common,
							coverUrl: video.cover,
							sourceKey: sourceKey(video.cover),
							...(await picture(video.cover, prior, download)),
						}
					: {
							...common,
							coverUrl: null,
							sourceKey: sourceKey(video.url),
							copy: "none",
						},
			);
		}
		read.push({
			role: r.role ?? null,
			event: r.event ?? null,
			description: r.description?.trim() || null,
			reasonText: r.reason_text?.trim() || null,
			note: r.note?.trim() || null,
			createdAt:
				r.create_time === undefined ? null : new Date(r.create_time * 1000),
			media,
		});
	}
	return read;
}

// One records request per return, a few at a time. Records that fail to
// load are named in failed, so their return saves with recordsUnread and a
// later pass asks again; what's already saved stays as it is.
const RECORD_REQUESTS_AT_ONCE = 4;

// until: a Date.now() past which no more are started; those left stay
// unread for the next pass.
export type ReadRecords = (
	wanted: { id: string; prior: Map<string, PriorPicture> }[],
	until?: number,
) => Promise<{
	read: Map<string, ReturnRecord[]>;
	failed: { id: string; error: string }[];
}>;

export const readReturnRecords: ReadRecords = async (wanted, until) => {
	const read = new Map<string, ReturnRecord[]>();
	const failed: { id: string; error: string }[] = [];
	if (wanted.length === 0) return { read, failed };
	const cipher = await shopCipher();
	const queue = [...wanted];
	const worker = async () => {
		for (let w = queue.shift(); w !== undefined; w = queue.shift()) {
			if (until !== undefined && Date.now() >= until) return;
			try {
				read.set(w.id, await returnRecords(cipher, w.id, w.prior));
			} catch (error) {
				failed.push({ id: w.id, error: errorText(error) });
			}
		}
	};
	await Promise.all(Array.from({ length: RECORD_REQUESTS_AT_ONCE }, worker));
	return { read, failed };
};

// What a read of these records means for its return, and the problems it
// names: a failed read or a picture that didn't download is read again next
// pass; a picture TikTok no longer serves is lost, and said once.
export function recordsOutcome(
	id: string,
	result: { records: ReturnRecord[] } | { error: string },
): {
	update: Pick<ChannelReturn, "note" | "records" | "recordsUnread">;
	problems: string[];
} {
	if ("error" in result)
		return {
			update: { recordsUnread: true },
			problems: [
				`TikTok return ${id} records: ${result.error}; asked again next pass`,
			],
		};
	const { records } = result;
	const media = records.flatMap((r) => r.media);
	const unfetched = media.filter((m) => m.copy === "unfetched").length;
	const gone = media.filter((m) => m.copy === "gone").length;
	const refused = media.filter(
		(m) => m.copy === "refused" || m.url === null,
	).length;
	return {
		update: {
			note: buyerNote(records),
			records,
			recordsUnread: !recordsComplete(records),
		},
		problems: [
			...(unfetched > 0
				? [
						`TikTok return ${id}: ${unfetched} of its photos didn't download; asked again next pass`,
					]
				: []),
			...(gone > 0
				? [`TikTok return ${id}: ${gone} of its photos are no longer on TikTok`]
				: []),
			...(refused > 0
				? [
						`TikTok return ${id}: ${refused} of its photo links aren't on TikTok's media hosts, so weren't downloaded`,
					]
				: []),
		],
	};
}
