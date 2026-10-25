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
// else; coveredThrough is how far it read, where the feed has such a mark.
export type FeedOutcome =
	| { kind: "read"; problems: string[]; coveredThrough?: Date }
	| { kind: "failed"; error: string }
	// The marketplace has nothing to read yet (a report still being built).
	| { kind: "pending" };

type Common = { attemptedAt: Date; coveredThrough: Date | null };

// A stored record, one shape per state, so a state can't carry another's
// fields. An ok or partial record succeeded at its attempt.
export type FeedRecord =
	| (Common & { state: "ok" })
	| (Common & { state: "partial"; problems: number; detail: string })
	| (Common & {
			state: "failed";
			error: string;
			failingSince: Date;
			succeededAt: Date | null;
	  })
	| (Common & { state: "pending"; succeededAt: Date | null });

export const succeededAt = (r: FeedRecord): Date | null =>
	r.state === "ok" || r.state === "partial" ? r.attemptedAt : r.succeededAt;

const later = (a: Date | null, b: Date | null | undefined) =>
	!a ? (b ?? null) : !b || a >= b ? a : b;

// The record after an attempt that started at startedAt. Null when the
// attempt is no news: it started no later than the one already counted (a
// slow pass finishing after a newer one, or the same run twice). A failure
// stands until the same feed reads again; waiting on a report doesn't clear
// it. How far a feed has read never moves back.
export function nextRecord(
	prev: FeedRecord | null,
	startedAt: Date,
	outcome: FeedOutcome,
): FeedRecord | null {
	if (prev && startedAt <= prev.attemptedAt) return null;
	const coveredThrough = prev?.coveredThrough ?? null;
	const lastGood = prev ? succeededAt(prev) : null;
	switch (outcome.kind) {
		case "read": {
			const common = {
				attemptedAt: startedAt,
				coveredThrough: later(coveredThrough, outcome.coveredThrough),
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
		case "failed":
			return {
				state: "failed",
				attemptedAt: startedAt,
				coveredThrough,
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
						coveredThrough,
						succeededAt: lastGood,
					};
	}
}

// What a feed shows. checkedAt is when it last read everything.
export type FeedStatus =
	| { state: "unsupported" }
	| { state: "not_connected" }
	| { state: "never" }
	| { state: "ok"; checkedAt: Date }
	| { state: "partial"; checkedAt: Date; problems: number; detail: string }
	| {
			state: "failed";
			checkedAt: Date | null;
			failingSince: Date;
			error: string;
	  }
	| { state: "pending"; checkedAt: Date | null; since: Date }
	// No good read within STALE_AFTER, though the latest didn't fail.
	| { state: "stale"; checkedAt: Date | null; attemptedAt: Date };

export function feedStatus(input: {
	channel: SyncedChannel;
	feed: Feed;
	configured: boolean;
	record: FeedRecord | null;
	now: Date;
}): FeedStatus {
	const { record } = input;
	if (!hasFeed(input.channel, input.feed)) return { state: "unsupported" };
	if (!input.configured) return { state: "not_connected" };
	if (!record) return { state: "never" };
	const checkedAt = succeededAt(record);
	if (record.state === "failed")
		return {
			state: "failed",
			checkedAt,
			failingSince: record.failingSince,
			error: record.error,
		};
	// A first report still being built isn't behind yet.
	const fresh =
		checkedAt === null
			? record.state === "pending"
			: input.now.getTime() - checkedAt.getTime() <=
				STALE_AFTER[input.feed] * 60_000;
	if (!fresh)
		return { state: "stale", checkedAt, attemptedAt: record.attemptedAt };
	switch (record.state) {
		case "ok":
			return { state: "ok", checkedAt: record.attemptedAt };
		case "partial":
			return {
				state: "partial",
				checkedAt: record.attemptedAt,
				problems: record.problems,
				detail: record.detail,
			};
		case "pending":
			return { state: "pending", checkedAt, since: record.attemptedAt };
	}
}

// A feed someone should look at: it failed, or fell behind.
export const feedStuck = (s: FeedStatus) =>
	s.state === "failed" || s.state === "stale";
