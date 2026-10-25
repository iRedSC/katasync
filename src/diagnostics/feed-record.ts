import { and, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { feedHealth } from "#/db/schema";
import { channelEnv, missingEnv, type SyncedChannel } from "./checks";
import {
	type Feed,
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
	const common = {
		attemptedAt: row.attemptedAt,
		coveredThrough: row.coveredThrough,
	};
	switch (row.state) {
		case "ok":
			return { ...common, state: "ok" };
		case "partial":
			return {
				...common,
				state: "partial",
				problems: row.problems,
				detail: row.detail ?? "",
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
		coveredThrough: r.coveredThrough,
		problems: 0,
		detail: null as string | null,
		failingSince: null as Date | null,
	};
	switch (r.state) {
		case "ok":
			return { ...base, succeededAt: r.attemptedAt };
		case "partial":
			return {
				...base,
				succeededAt: r.attemptedAt,
				problems: r.problems,
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
		recordFeed(db, channel, feed, startedAt, outcome).catch((e: unknown) =>
			console.error(`Couldn't record ${channel} ${feed} health:`, e),
		);
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

// Every stored record, by channel and feed.
export async function loadFeedRecords(db: Db) {
	const rows = await db.select().from(feedHealth);
	const byKey = new Map(
		rows.map((r) => [`${r.channel}:${r.feed}`, recordOf(r)] as const),
	);
	return (channel: SyncedChannel, feed: Feed) =>
		byKey.get(`${channel}:${feed}`) ?? null;
}

// One feed on every channel that has it, for a page showing when it was
// last read (the Returns tab).
export async function feedOnChannels(db: Db, feed: Feed, now = new Date()) {
	const recordFor = await loadFeedRecords(db);
	return (Object.keys(channelEnv) as SyncedChannel[])
		.filter((channel) => hasFeed(channel, feed))
		.map((channel) => ({
			channel,
			...feedStatus({
				channel,
				feed,
				configured: missingEnv(channelEnv[channel]).length === 0,
				record: recordFor(channel, feed),
				now,
			}),
		}));
}
