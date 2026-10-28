import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { returnRequests } from "#/db/schema";
import {
	type PriorPicture,
	priorPictures,
	saveRecords,
} from "#/orders/return-records";
import type { ChannelReturn, FoundReturns } from "#/orders/return-requests";
import {
	type ReadRecords,
	readReturnRecords,
	recordsOutcome,
} from "./tiktok-return-records";

// TikTok's return records (the buyer's note and evidence) cost a request per
// return, so a returns pass asks only for those that are new or that TikTok
// changed since they were saved, and again for any whose records couldn't
// be read whole before. Server only.

type Wanted = Map<string, Map<string, PriorPicture>>;

// The returns given their records, as far as they read. wanted: the ones to
// ask for, with each one's pictures as last saved.
export async function withRecords(
	returns: ChannelReturn[],
	wanted: Wanted,
	read: ReadRecords = readReturnRecords,
): Promise<{ returns: ChannelReturn[]; problems: string[] }> {
	const { read: found, failed } = await read(
		returns
			.filter((r) => wanted.has(r.externalId))
			.map((r) => ({
				id: r.externalId,
				prior: wanted.get(r.externalId) ?? new Map(),
			})),
	);
	const errors = new Map(failed.map((f) => [f.id, f.error]));
	const problems: string[] = [];
	return {
		returns: returns.map((r) => {
			const records = found.get(r.externalId);
			const error = errors.get(r.externalId);
			if (!records && error === undefined) return r;
			const outcome = recordsOutcome(
				r.externalId,
				records ? { records } : { error: error ?? "" },
			);
			problems.push(...outcome.problems);
			return { ...r, ...outcome.update };
		}),
		problems,
	};
}

// The returns whose records are worth asking for, with their pictures.
export async function recordsWanted(db: Db, found: ChannelReturn[]) {
	const wanted: Wanted = new Map();
	if (found.length === 0) return wanted;
	const saved = await db
		.select({
			id: returnRequests.id,
			externalId: returnRequests.externalId,
			sourceUpdatedAt: returnRequests.sourceUpdatedAt,
			recordsUnread: returnRequests.recordsUnread,
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
	const prior = await priorPictures(
		db,
		saved.map((s) => s.id),
	);
	for (const r of found) {
		const s = byId.get(r.externalId);
		if (
			!s ||
			s.recordsUnread ||
			s.sourceUpdatedAt.getTime() !== r.updatedAt?.getTime()
		)
			wanted.set(r.externalId, (s && prior.get(s.id)) ?? new Map());
	}
	return wanted;
}

// One window's TikTok returns, with the records worth asking for.
export async function tiktokReturnsWithRecords(
	db: Db,
	found: ChannelReturn[],
	read: ReadRecords = readReturnRecords,
): Promise<FoundReturns> {
	return withRecords(found, await recordsWanted(db, found), read);
}

// Records that couldn't be read whole on an earlier pass, asked for again
// however old their return is: a batch per pass, those asked longest ago
// first, so a backlog (every case from before records were kept) works
// through over passes and one that keeps failing doesn't hold back the
// rest. Stops starting new ones at until (a Date.now()).
const RETRY_BATCH = 40;

export async function retryUnreadRecords(
	db: Db,
	read: ReadRecords = readReturnRecords,
	until?: number,
): Promise<string[]> {
	const due = await db
		.select({
			id: returnRequests.id,
			externalId: returnRequests.externalId,
			sourceUpdatedAt: returnRequests.sourceUpdatedAt,
		})
		.from(returnRequests)
		.where(
			and(
				eq(returnRequests.billedBy, "tiktok"),
				eq(returnRequests.recordsUnread, true),
			),
		)
		.orderBy(
			sql`${returnRequests.recordsAskedAt} asc nulls first`,
			asc(returnRequests.id),
		)
		.limit(RETRY_BATCH);
	const prior = await priorPictures(
		db,
		due.map((d) => d.id),
	);
	const { read: found, failed } = await read(
		due.map((d) => ({
			id: d.externalId,
			prior: prior.get(d.id) ?? new Map(),
		})),
		until,
	);
	const errors = new Set(failed.map((f) => f.id));
	const problems = failed.flatMap(
		(f) => recordsOutcome(f.id, { error: f.error }).problems,
	);
	for (const d of due) {
		const records = found.get(d.externalId);
		if (!records) {
			if (errors.has(d.externalId))
				await db
					.update(returnRequests)
					.set({ recordsAskedAt: sql`now()` })
					.where(eq(returnRequests.id, d.id));
			continue;
		}
		const { update, problems: more } = recordsOutcome(d.externalId, {
			records,
		});
		problems.push(...more);
		await db.transaction(async (tx) => {
			// Only over the version these were read against: a save since
			// (a webhook's, say) carries records of its own.
			const [still] = await tx
				.update(returnRequests)
				.set({
					note: update.note,
					recordsUnread: update.recordsUnread,
					noteUnread: update.recordsUnread,
					recordsAskedAt: sql`now()`,
				})
				.where(
					and(
						eq(returnRequests.id, d.id),
						eq(returnRequests.sourceUpdatedAt, d.sourceUpdatedAt),
					),
				)
				.returning({ id: returnRequests.id });
			if (still) await saveRecords(tx, d.id, records);
		});
	}
	return problems;
}
