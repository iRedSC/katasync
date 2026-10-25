import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { returnRequests } from "#/db/schema";
import type { ChannelReturn, FoundReturns } from "#/orders/return-requests";
import { readBuyerNotes, withBuyerNotes } from "./tiktok-returns";

// TikTok's buyer notes cost a request per return, so a returns pass asks
// only for those that are new or that TikTok changed since they were saved,
// and again for any whose note couldn't be read before. Server only.

type ReadNotes = typeof readBuyerNotes;

// The returns whose note is worth asking for.
export async function notesWanted(db: Db, found: ChannelReturn[]) {
	if (found.length === 0) return new Set<string>();
	const saved = await db
		.select({
			externalId: returnRequests.externalId,
			sourceUpdatedAt: returnRequests.sourceUpdatedAt,
			noteUnread: returnRequests.noteUnread,
		})
		.from(returnRequests)
		.where(
			and(
				eq(returnRequests.billedBy, "tiktok"),
				inArray(
					returnRequests.externalId,
					found.map((r) => r.externalId),
				),
			),
		);
	const byId = new Map(saved.map((s) => [s.externalId, s]));
	return new Set(
		found
			.filter((r) => {
				const s = byId.get(r.externalId);
				return (
					!s ||
					s.noteUnread ||
					s.sourceUpdatedAt.getTime() !== r.updatedAt?.getTime()
				);
			})
			.map((r) => r.externalId),
	);
}

// One window's TikTok returns, with the notes worth asking for.
export async function tiktokReturnsWithNotes(
	db: Db,
	found: ChannelReturn[],
	read: ReadNotes = readBuyerNotes,
): Promise<FoundReturns> {
	return withBuyerNotes(found, await notesWanted(db, found), read);
}

// Notes that couldn't be read on an earlier pass, asked for again however
// old their return is, a batch per pass.
const RETRY_BATCH = 40;

export async function retryUnreadNotes(
	db: Db,
	read: ReadNotes = readBuyerNotes,
): Promise<string[]> {
	const due = await db
		.select({ externalId: returnRequests.externalId })
		.from(returnRequests)
		.where(
			and(
				eq(returnRequests.billedBy, "tiktok"),
				eq(returnRequests.noteUnread, true),
			),
		)
		.limit(RETRY_BATCH);
	const { notes, failed } = await read(due.map((d) => d.externalId));
	for (const [externalId, note] of notes)
		await db
			.update(returnRequests)
			.set({ note, noteUnread: false })
			.where(
				and(
					eq(returnRequests.billedBy, "tiktok"),
					eq(returnRequests.externalId, externalId),
				),
			);
	return failed.map(
		(f) => `TikTok return ${f.id} note: ${f.error}; asked again next pass`,
	);
}
