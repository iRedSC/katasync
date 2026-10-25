// How each feed of each channel stands: what one attempt does to its record,
// and what Diagnostics and the Returns tab show for it. Pure, so it's tested
// without a database; src/diagnostics/feed-record.ts stores it.

import type { feedState, syncFeed } from "#/db/schema";
import type { SyncedChannel } from "./checks";
import { STALE_AFTER_MINUTES } from "./health";

export type Feed = (typeof syncFeed.enumValues)[number];
export type FeedState = (typeof feedState.enumValues)[number];

// The feeds each channel has, in the order Diagnostics lists them. Shopify
// has no buyer messages here; Amazon's tracking goes back by hand.
export const FEEDS = {
	shopify: ["orders", "returns", "charges", "tracking"],
	tiktok: ["orders", "returns", "messages", "charges", "tracking"],
	ebay: ["orders", "returns", "messages", "charges", "tracking"],
	amazon: ["orders", "returns", "messages", "charges"],
} as const satisfies Record<SyncedChannel, readonly Feed[]>;

export const ALL_FEEDS: readonly Feed[] = [
	"orders",
	"returns",
	"messages",
	"charges",
	"tracking",
];

export const hasFeed = (channel: SyncedChannel, feed: Feed) =>
	(FEEDS[channel] as readonly Feed[]).includes(feed);

// Without a good read in this long, a feed is behind even if nothing failed:
// a few of its passes missed. Returns run every 15 minutes, messages every 5,
// the rest every four hours.
export const STALE_AFTER: Record<Feed, number> = {
	orders: STALE_AFTER_MINUTES,
	returns: 50,
	messages: 30,
	charges: STALE_AFTER_MINUTES,
	tracking: STALE_AFTER_MINUTES,
};

// What one attempt found. A read with problems still read everything
// else. readThrough is where reading got to, in the marketplace's own time,
// where the feed has such a mark; catching_up read fine but stopped short
// of now, so it's never ok.
export type FeedOutcome =
	| { kind: "read"; problems: string[]; readThrough?: Date }
	| { kind: "catching_up"; problems: string[]; readThrough: Date }
	| { kind: "failed"; error: string }
	// The marketplace has nothing to read yet (a report still being built).
	| { kind: "pending" };

type Common = { attemptedAt: Date; readThrough: Date | null };

// A stored record, one shape per state, so a state can't carry another's
// fields. An ok, partial, or catching_up record succeeded at its attempt.
export type FeedRecord =
	| (Common & { state: "ok" })
	| (Common & { state: "partial"; problems: number; detail: string })
	| {
			state: "catching_up";
			attemptedAt: Date;
			readThrough: Date;
			problems: number;
			detail: string | null;
	  }
	| (Common & {
			state: "failed";
			error: string;
			failingSince: Date;
			succeededAt: Date | null;
	  })
	| (Common & { state: "pending"; succeededAt: Date | null });

export const succeededAt = (r: FeedRecord): Date | null =>
	r.state === "failed" || r.state === "pending" ? r.succeededAt : r.attemptedAt;

const later = (a: Date | null, b: Date | null | undefined) =>
	!a ? (b ?? null) : !b || a >= b ? a : b;

// The record after an attempt that started at startedAt. Null when the
// attempt is no news: it started no later than the one already counted (a
// slow pass finishing after a newer one, or the same run twice). A failure
// stands until the same feed reads again; waiting on a report doesn't clear
// it. Where reading got to never moves back.
export function nextRecord(
	prev: FeedRecord | null,
	startedAt: Date,
	outcome: FeedOutcome,
): FeedRecord | null {
	if (prev && startedAt <= prev.attemptedAt) return null;
	const readThrough = prev?.readThrough ?? null;
	const lastGood = prev ? succeededAt(prev) : null;
	switch (outcome.kind) {
		case "read": {
			const common = {
				attemptedAt: startedAt,
				readThrough: later(readThrough, outcome.readThrough),
			};
			return outcome.problems.length === 0
				? { ...common, state: "ok" }
				: {
						...common,
						state: "partial",
						problems: outcome.problems.length,
						detail: outcome.problems[0],
					};
		}
		case "catching_up": {
			const through = later(readThrough, outcome.readThrough) ?? startedAt;
			// Reading got up to now after all: that's a read.
			if (through >= startedAt)
				return nextRecord(prev, startedAt, { ...outcome, kind: "read" });
			return {
				state: "catching_up",
				attemptedAt: startedAt,
				readThrough: through,
				problems: outcome.problems.length,
				detail: outcome.problems[0] ?? null,
			};
		}
		case "failed":
			return {
				state: "failed",
				attemptedAt: startedAt,
				readThrough,
				error: outcome.error,
				failingSince: prev?.state === "failed" ? prev.failingSince : startedAt,
				succeededAt: lastGood,
			};
		case "pending":
			return prev?.state === "failed"
				? { ...prev, attemptedAt: startedAt }
				: {
						state: "pending",
						attemptedAt: startedAt,
						readThrough,
						succeededAt: lastGood,
					};
	}
}

// A stretch of a feed that isn't verified (feed_gaps): records there
// couldn't be saved, or no regular pass can read it.
export type FeedGap = {
	kind: "unsaved" | "unread";
	from: Date;
	until: Date;
	detail: string;
};

// What a feed shows. checkedAt is where it has read everything up to: the
// marketplace time it read through where it has one, else when it last
// read. coveredThrough stops at the oldest open gap, so it never passes a
// record that wasn't saved.
export type FeedStatus =
	| { state: "unsupported" }
	| { state: "not_connected" }
	| { state: "never" }
	| { state: "ok"; checkedAt: Date }
	| {
			state: "partial";
			checkedAt: Date;
			coveredThrough: Date | null;
			problems: number;
			detail: string;
	  }
	| {
			state: "catching_up";
			coveredThrough: Date;
			attemptedAt: Date;
			behindDays: number;
	  }
	// Some of it no pass can reach: a history import has to read it.
	| {
			state: "needs_history";
			checkedAt: Date;
			gaps: { from: Date; until: Date }[];
	  }
	| {
			state: "failed";
			checkedAt: Date | null;
			failingSince: Date;
			error: string;
	  }
	| { state: "pending"; checkedAt: Date | null; since: Date }
	// No good read within STALE_AFTER, though the latest didn't fail.
	| { state: "stale"; checkedAt: Date | null; attemptedAt: Date };

const DAY_MS = 86_400_000;

export function feedStatus(input: {
	channel: SyncedChannel;
	feed: Feed;
	configured: boolean;
	record: FeedRecord | null;
	gaps?: FeedGap[];
	now: Date;
}): FeedStatus {
	const { record, now } = input;
	const gaps = input.gaps ?? [];
	if (!hasFeed(input.channel, input.feed)) return { state: "unsupported" };
	if (!input.configured) return { state: "not_connected" };
	if (!record) return { state: "never" };
	const checkedAt = record.readThrough ?? succeededAt(record);
	if (record.state === "failed")
		return {
			state: "failed",
			checkedAt,
			failingSince: record.failingSince,
			error: record.error,
		};
	const within = (at: Date) =>
		now.getTime() - at.getTime() <= STALE_AFTER[input.feed] * 60_000;
	if (record.state === "catching_up")
		return within(record.attemptedAt)
			? {
					state: "catching_up",
					coveredThrough: coveredThrough(record.readThrough, gaps),
					attemptedAt: record.attemptedAt,
					behindDays: Math.max(
						1,
						Math.ceil(
							(record.attemptedAt.getTime() - record.readThrough.getTime()) /
								DAY_MS,
						),
					),
				}
			: { state: "stale", checkedAt, attemptedAt: record.attemptedAt };
	// A first report still being built isn't behind yet.
	if (checkedAt === null)
		return record.state === "pending"
			? { state: "pending", checkedAt, since: record.attemptedAt }
			: { state: "stale", checkedAt, attemptedAt: record.attemptedAt };
	if (!within(checkedAt))
		return { state: "stale", checkedAt, attemptedAt: record.attemptedAt };
	const unread = gaps.filter((g) => g.kind === "unread");
	if (unread.length > 0)
		return {
			state: "needs_history",
			checkedAt,
			gaps: unread.map((g) => ({ from: g.from, until: g.until })),
		};
	const unsaved = gaps.filter((g) => g.kind === "unsaved");
	if (record.state === "partial" || unsaved.length > 0)
		return {
			state: "partial",
			checkedAt,
			coveredThrough: record.readThrough
				? coveredThrough(record.readThrough, gaps)
				: null,
			problems: record.state === "partial" ? record.problems : unsaved.length,
			detail: record.state === "partial" ? record.detail : unsaved[0].detail,
		};
	if (record.state === "pending")
		return { state: "pending", checkedAt, since: record.attemptedAt };
	return { state: "ok", checkedAt };
}

// Verified up to here: where reading got to, or the oldest open gap.
export function coveredThrough(readThrough: Date, gaps: FeedGap[]): Date {
	return gaps.reduce((at, g) => (g.from < at ? g.from : at), readThrough);
}

// A feed someone should look at: it failed, fell behind, or needs a history
// import.
export const feedStuck = (s: FeedStatus) =>
	s.state === "failed" || s.state === "stale" || s.state === "needs_history";
