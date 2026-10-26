import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { feedHealth, stores } from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import type { FeedOutcome } from "#/diagnostics/feed-health";
import { openGaps, recordFeed, settleGaps } from "#/diagnostics/feed-record";
import { errorText } from "#/diagnostics/runs";
import { type Held, importReturns } from "#/orders/return-requests";
import { ebayCasesPass } from "./ebay-cases-pass";
import {
	type ReturnsReader,
	type ReturnsWindow,
	returnsReaders,
} from "./returns-readers";

// One returns pass of a channel, every 15 minutes on its own cron
// (src/routes/api/cron/returns.$channel.ts), apart from orders and listings.
// It reads from a little before where reading got to, a chunk at a time
// within a time budget, so an outage is caught up over passes rather than
// skipped, and it's never called up to date until it is. A record it reads
// but can't save is held as a gap (feed_gaps) and read again each pass, so
// what's verified never passes it. Server only.

const DAY = 24 * 60 * 60 * 1000;
// Reread before the mark: a return on an order the orders pass hasn't
// brought in yet comes in once the order does.
const OVERLAP_MS = DAY;
// Inside Vercel's 300 seconds, with room for the slowest last read.
export const BUDGET_MS = 150_000;
// Read through to within this of now counts as up to date (a shared
// Amazon report is up to 25 minutes old).
const CURRENT_MS = 60 * 60 * 1000;
// Held records read again per pass, oldest first.
const GAP_REREADS = 10;
// A held record's moment, read again on its own.
const AROUND_MS = 1000;

type Options = {
	now?: Date;
	// Milliseconds now, for the budget.
	clock?: () => number;
	budgetMs?: number;
	reader?: ReturnsReader;
};

// Reads the channel's returns and records how it went on the returns feed.
// A failure is the feed's outcome, not thrown.
export async function returnsPass(
	db: Db,
	channel: SyncedChannel,
	options: Options = {},
): Promise<FeedOutcome> {
	const now = options.now ?? new Date();
	const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS);
	const cases: FeedOutcome[] = [];
	if (channel === "ebay" && !options.reader) {
		cases.push(
			await ebayCasesPass(
				db,
				"cases",
				now,
				Math.min(deadline, Date.now() + 65_000),
			),
		);
		cases.push(
			await ebayCasesPass(
				db,
				"disputes",
				now,
				Math.min(deadline, Date.now() + 25_000),
			),
		);
	}
	const outcome = await readReturns(db, channel, now, {
		...options,
		budgetMs: Math.max(0, deadline - Date.now()),
	}).catch(
		(error: unknown): FeedOutcome => ({
			kind: "failed",
			error: errorText(error),
		}),
	);
	await recordFeed(db, channel, "returns", now, outcome);
	const failed = cases.find((result) => result.kind === "failed");
	if (failed) return failed;
	if (
		outcome.kind === "read" &&
		cases.some((result) => result.kind !== "read" || result.problems.length)
	)
		return {
			...outcome,
			problems: [
				...outcome.problems,
				"eBay cases are not fully checked; see cases and disputes feeds",
			],
		};
	return outcome;
}

// Where the next read starts: a little before where reading got to, and no
// further back than the channel's reach; what's past that is unread.
export function returnsStart(
	readThrough: Date | null,
	now: Date,
	reader: Pick<ReturnsReader, "firstDays" | "reachDays">,
): { from: Date; unread: ReturnsWindow | null } {
	const wanted = readThrough
		? readThrough.getTime() - OVERLAP_MS
		: now.getTime() - reader.firstDays * DAY;
	if (reader.reachDays === undefined)
		return { from: new Date(wanted), unread: null };
	const reach = now.getTime() - reader.reachDays * DAY;
	return {
		from: new Date(reach),
		unread:
			wanted < reach
				? { from: new Date(wanted), until: new Date(reach) }
				: null,
	};
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const asGaps = (held: Held[]) =>
	held.map((h) => ({ from: h.at, until: h.at, detail: h.detail }));

async function readReturns(
	db: Db,
	channel: SyncedChannel,
	now: Date,
	options: Options,
): Promise<FeedOutcome> {
	const clock = options.clock ?? Date.now;
	const deadline = clock() + (options.budgetMs ?? BUDGET_MS);
	const reader = options.reader ?? returnsReaders(db, deadline)[channel];
	const [store] = await db
		.select()
		.from(stores)
		.where(eq(stores.channel, channel))
		.limit(1);
	if (!store)
		return {
			kind: "failed",
			error: `No ${channel} store yet: its orders haven't synced`,
		};
	const [health] = await db
		.select({ readThrough: feedHealth.readThrough })
		.from(feedHealth)
		.where(
			and(eq(feedHealth.channel, channel), eq(feedHealth.feed, "returns")),
		);
	const start = returnsStart(health?.readThrough ?? null, now, reader);
	if (start.unread)
		await settleGaps(
			db,
			channel,
			"returns",
			{ kind: "unread", ...start.unread },
			[
				{
					...start.unread,
					detail: `${store.name} returns opened ${day(start.unread.from)} to ${day(start.unread.until)} weren't read: no regular pass reaches that far back`,
				},
			],
		);

	const problems: string[] = [];
	let reached = start.from;
	// Each chunk saves before the next, so a catch-up cut short by the
	// budget keeps what it read.
	while (reached < now && clock() < deadline) {
		const ask = {
			from: reached,
			until: new Date(
				Math.min(now.getTime(), reached.getTime() + reader.chunkDays * DAY),
			),
		};
		let covered = ask;
		const read = await importReturns(db, store, async () => {
			const got = await reader.read(ask);
			if (got?.covered) covered = got.covered;
			return got?.found ?? null;
		});
		if (read.kind === "failed") return read;
		if (read.kind === "pending")
			return reached > start.from
				? { kind: "catching_up", problems, readThrough: reached }
				: read;
		// Amazon may build a report starting later than asked.
		if (covered.from > ask.from)
			await settleGaps(db, channel, "returns", { kind: "unread", ...ask }, [
				{
					from: ask.from,
					until: covered.from,
					detail: `${store.name} returns opened ${day(ask.from)} to ${day(covered.from)} weren't in its report`,
				},
			]);
		await settleGaps(
			db,
			channel,
			"returns",
			{ kind: "unsaved", ...covered },
			asGaps(read.held),
		);
		problems.push(...read.problems);
		if (covered.until <= reached) break;
		reached = covered.until;
	}

	const caughtUp = now.getTime() - reached.getTime() <= CURRENT_MS;
	if (caughtUp) {
		if (reader.rereadsGaps)
			await rereadHeld(
				db,
				store,
				channel,
				reader,
				deadline,
				clock,
				start.from,
				problems,
			);
		if (reader.after && clock() < deadline) {
			const after = reader.after;
			const extra = await importReturns(db, store, () => after(now));
			if (extra.kind === "failed") problems.push(extra.error);
			if (extra.kind === "read") {
				problems.push(...extra.problems);
				for (const h of extra.held)
					await settleGaps(
						db,
						channel,
						"returns",
						{ kind: "unsaved", from: h.at, until: h.at },
						asGaps([h]),
					);
			}
		}
	}

	// What's still held or unread keeps the feed from reading ok.
	const open = await openGaps(db, channel, "returns");
	const unsaved = open.filter((g) => g.kind === "unsaved");
	const unread = open.filter((g) => g.kind === "unread");
	if (unsaved.length > 0)
		problems.push(
			`${unsaved.length} ${unsaved.length === 1 ? "return" : "returns"} held since ${day(unsaved[0].from)}: ${unsaved[0].detail}`,
		);
	for (const g of unread)
		problems.push(
			`${g.detail}; run pnpm sync --returns-history ${Math.ceil((now.getTime() - g.from.getTime()) / DAY)} --only ${channel}`,
		);
	return caughtUp
		? { kind: "read", problems, readThrough: reached }
		: { kind: "catching_up", problems, readThrough: reached };
}

// Each held record from before this pass's read, read again at its own
// moment: once it saves (its order came in), its gap closes.
async function rereadHeld(
	db: Db,
	store: Parameters<typeof importReturns>[1],
	channel: SyncedChannel,
	reader: ReturnsReader,
	deadline: number,
	clock: () => number,
	before: Date,
	problems: string[],
) {
	const held = (await openGaps(db, channel, "returns", "unsaved"))
		.filter((g) => g.until < before)
		.slice(0, GAP_REREADS);
	for (const g of held) {
		if (clock() >= deadline) return;
		const around = {
			from: new Date(g.from.getTime() - AROUND_MS),
			until: new Date(g.until.getTime() + AROUND_MS),
		};
		const read = await importReturns(db, store, async () => {
			const got = await reader.read(around);
			return got?.found ?? null;
		});
		if (read.kind === "failed") problems.push(read.error);
		if (read.kind === "read") {
			problems.push(...read.problems);
			await settleGaps(
				db,
				channel,
				"returns",
				{ kind: "unsaved", ...around },
				asGaps(read.held),
			);
		}
	}
}
