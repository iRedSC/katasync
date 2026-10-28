import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { feedGaps, feedHealth } from "#/db/schema";
import { channelEnv, missingEnv, type SyncedChannel } from "./checks";
import {
	type Feed,
	type FeedGap,
	type FeedOutcome,
	type FeedRecord,
	feedStatus,
	hasFeed,
	nextRecord,
} from "./feed-health";
import { errorText } from "./runs";

// Stores each feed's record (feed-health.ts) as its attempts end. Server only.

type Row = typeof feedHealth.$inferSelect;

export function recordOf(row: Row): FeedRecord {
	const common = { attemptedAt: row.attemptedAt, readThrough: row.readThrough };
	switch (row.state) {
		case "ok":
			return { ...common, state: "ok", excluded: row.excluded };
		case "partial":
			return {
				...common,
				state: "partial",
				problems: row.problems,
				excluded: row.excluded,
				detail: row.detail ?? "",
			};
		case "catching_up":
			return {
				state: "catching_up",
				attemptedAt: row.attemptedAt,
				readThrough: row.readThrough ?? row.attemptedAt,
				problems: row.problems,
				excluded: row.excluded,
				detail: row.detail,
			};
		case "failed":
			return {
				...common,
				state: "failed",
				error: row.detail ?? "",
				failingSince: row.failingSince ?? row.attemptedAt,
				succeededAt: row.succeededAt,
			};
		case "pending":
			return { ...common, state: "pending", succeededAt: row.succeededAt };
	}
}

function rowOf(r: FeedRecord) {
	const base = {
		state: r.state,
		attemptedAt: r.attemptedAt,
		readThrough: r.readThrough,
		problems: 0,
		excluded: 0,
		detail: null as string | null,
		failingSince: null as Date | null,
	};
	switch (r.state) {
		case "ok":
			return { ...base, succeededAt: r.attemptedAt, excluded: r.excluded };
		case "partial":
		case "catching_up":
			return {
				...base,
				succeededAt: r.attemptedAt,
				problems: r.problems,
				excluded: r.excluded,
				detail: r.detail,
			};
		case "failed":
			return {
				...base,
				succeededAt: r.succeededAt,
				detail: r.error,
				failingSince: r.failingSince,
			};
		case "pending":
			return { ...base, succeededAt: r.succeededAt };
	}
}

// Counts one attempt that started at startedAt. The row is locked while the
// next record is worked out, so two attempts ending at once both count in
// order; one older than what's stored changes nothing. Returns the record
// now stored, or null when the attempt was no news.
export async function recordFeed(
	db: Db,
	channel: SyncedChannel,
	feed: Feed,
	startedAt: Date,
	outcome: FeedOutcome,
): Promise<FeedRecord | null> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(feedHealth)
			.where(and(eq(feedHealth.channel, channel), eq(feedHealth.feed, feed)))
			.for("update");
		const next = nextRecord(row ? recordOf(row) : null, startedAt, outcome);
		if (!next) return null;
		const values = rowOf(next);
		// Without a row to lock, two first attempts can both insert: the
		// later start wins.
		const [stored] = await tx
			.insert(feedHealth)
			.values({ channel, feed, ...values })
			.onConflictDoUpdate({
				target: [feedHealth.channel, feedHealth.feed],
				set: values,
				setWhere: sql`${feedHealth.attemptedAt} < excluded.attempted_at`,
			})
			.returning();
		return stored ? recordOf(stored) : null;
	});
}

// Counts an attempt; one that can't be written is logged, never thrown.
export function recordQuietly(
	db: Db,
	channel: SyncedChannel,
	feed: Feed,
	startedAt: Date,
	outcome: FeedOutcome,
) {
	return recordFeed(db, channel, feed, startedAt, outcome).catch((e: unknown) =>
		console.error(`Couldn't record ${channel} ${feed} health:`, e),
	);
}

// Runs one attempt at a feed and counts it: what it found, by outcomeOf, or
// that it threw, which is thrown again so the caller still sees it. A record
// that can't be written is logged, never thrown over the attempt's result.
export async function readingFeed<T>(
	db: Db,
	channel: SyncedChannel,
	feed: Feed,
	work: () => Promise<T>,
	outcomeOf: (result: T) => FeedOutcome,
): Promise<T> {
	const startedAt = new Date();
	const record = (outcome: FeedOutcome) =>
		recordQuietly(db, channel, feed, startedAt, outcome);
	let result: T;
	try {
		result = await work();
	} catch (error) {
		await record({ kind: "failed", error: errorText(error) });
		throw error;
	}
	await record(outcomeOf(result));
	return result;
}

// Every stored record and open gap, by channel and feed.
export async function loadFeedRecords(db: Db) {
	const [rows, gapRows] = await Promise.all([
		db.select().from(feedHealth),
		db.select().from(feedGaps).orderBy(asc(feedGaps.from)),
	]);
	const key = (channel: string, feed: string) => `${channel}:${feed}`;
	const records = new Map(
		rows.map((r) => [key(r.channel, r.feed), recordOf(r)] as const),
	);
	const gaps = new Map<string, FeedGap[]>();
	for (const g of gapRows) {
		const k = key(g.channel, g.feed);
		gaps.set(k, [...(gaps.get(k) ?? []), g]);
	}
	return {
		record: (channel: SyncedChannel, feed: Feed) =>
			records.get(key(channel, feed)) ?? null,
		gaps: (channel: SyncedChannel, feed: Feed) =>
			gaps.get(key(channel, feed)) ?? [],
	};
}

export type FeedRecords = Awaited<ReturnType<typeof loadFeedRecords>>;

// One feed on every channel that has it, for a page showing when it was
// last read (the Returns tab).
export async function feedOnChannels(db: Db, feed: Feed, now = new Date()) {
	const loaded = await loadFeedRecords(db);
	return (Object.keys(channelEnv) as SyncedChannel[])
		.filter((channel) => hasFeed(channel, feed))
		.map((channel) => ({
			channel,
			feed,
			...feedStatus({
				channel,
				feed,
				configured: missingEnv(channelEnv[channel]).length === 0,
				record: loaded.record(channel, feed),
				gaps: loaded.gaps(channel, feed),
				now,
			}),
		}));
}

// The feed's open gaps, oldest first.
export function openGaps(
	db: Db,
	channel: SyncedChannel,
	feed: Feed,
	kind?: FeedGap["kind"],
) {
	return db
		.select()
		.from(feedGaps)
		.where(
			and(
				eq(feedGaps.channel, channel),
				eq(feedGaps.feed, feed),
				kind ? eq(feedGaps.kind, kind) : undefined,
			),
		)
		.orderBy(asc(feedGaps.from));
}

// A read of from..until that saved everything closes the gaps of this kind
// inside it; then those it found are opened (again). One transaction, so a
// gap is never briefly closed while its record is still unsaved.
export async function settleGaps(
	db: Db,
	channel: SyncedChannel,
	feed: Feed,
	read: { kind: FeedGap["kind"]; from: Date; until: Date },
	found: { from: Date; until: Date; detail: string }[],
) {
	await db.transaction(async (tx) => {
		await tx
			.delete(feedGaps)
			.where(
				and(
					eq(feedGaps.channel, channel),
					eq(feedGaps.feed, feed),
					eq(feedGaps.kind, read.kind),
					gte(feedGaps.from, read.from),
					lte(feedGaps.until, read.until),
				),
			);
		if (found.length > 0)
			await tx
				.insert(feedGaps)
				.values(found.map((g) => ({ channel, feed, kind: read.kind, ...g })))
				.onConflictDoUpdate({
					target: [
						feedGaps.channel,
						feedGaps.feed,
						feedGaps.kind,
						feedGaps.from,
						feedGaps.until,
					],
					set: { detail: sql`excluded.detail` },
				});
	});
}
