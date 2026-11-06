import { type } from "arktype";
import { eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { marketplaceStatements } from "#/db/schema";
import { errorText } from "#/diagnostics/runs";
import { SHOP_TIME_ZONE } from "#/lib/format";
import {
	lastMonth,
	type Period,
	periodText,
	shiftPeriod,
} from "#/orders/sales-report";
import { fetchAmazonStatement } from "./amazon";
import { fetchEbayStatement } from "./ebay";
import { shopifyStatement } from "./shopify";
import { fetchTiktokStatement } from "./tiktok";
import {
	STATEMENT_CHANNELS,
	type Statement,
	type StatementChannel,
	type StatementResult,
	statement,
} from "./types";
import { monthWindow, PACIFIC } from "./window";

// Reads a marketplace's figures for a month and keeps them. The cost cron
// reads the month so far and the month before (statementPeriods); any other
// month is read when someone asks for it on the Reports tab.

const READERS: Record<StatementChannel, (p: Period) => Promise<Statement>> = {
	shopify: (p) => shopifyStatement(monthWindow(p, SHOP_TIME_ZONE)),
	amazon: (p) => fetchAmazonStatement(monthWindow(p, PACIFIC)),
	ebay: (p) => fetchEbayStatement(monthWindow(p, PACIFIC)),
	tiktok: (p) => fetchTiktokStatement(monthWindow(p, PACIFIC)),
};

export type StatementRefresh =
	| { kind: "read" }
	| { kind: "failed"; error: string };

export async function refreshStatement(
	db: Db,
	channel: StatementChannel,
	period: Period,
	// The marketplace's reader; tests stand one in.
	read: (p: Period) => Promise<Statement> = READERS[channel],
): Promise<StatementRefresh> {
	const key = { channel, period: periodText(period) };
	// Figures are as of when the read began. Two reads crossing (the cron and
	// "Read again") keep the one that began later, whichever finishes last.
	const startedAt = new Date();
	try {
		const figures = await read(period);
		await db
			.insert(marketplaceStatements)
			.values({ ...key, statement: figures, readAt: startedAt })
			.onConflictDoUpdate({
				target: [marketplaceStatements.channel, marketplaceStatements.period],
				set: {
					statement: figures,
					readAt: startedAt,
					error: null,
					erroredAt: null,
				},
				setWhere: sql`${marketplaceStatements.readAt} is null
					or ${marketplaceStatements.readAt} < excluded.read_at`,
			});
		return { kind: "read" };
	} catch (e) {
		const error = errorText(e);
		// Best effort: if the database is what failed, this fails too, and the
		// error still goes back to the caller. Kept beside the last good read,
		// which then shows as older figures.
		await db
			.insert(marketplaceStatements)
			.values({ ...key, error, erroredAt: startedAt })
			.onConflictDoUpdate({
				target: [marketplaceStatements.channel, marketplaceStatements.period],
				set: { error, erroredAt: startedAt },
				setWhere: sql`${marketplaceStatements.readAt} is null
					or ${marketplaceStatements.readAt} < excluded.errored_at`,
			})
			.catch(() => {});
		return { kind: "failed", error };
	}
}

// The month so far, or the one before, which keeps changing for a while
// after it ends as late postings land. Each is its own cron call, so Amazon's
// two months never share one function's time limit.
export type RecentMonth = "current" | "previous";

export function recentPeriod(which: RecentMonth, now = new Date()): Period {
	const before = lastMonth(now);
	return which === "previous" ? before : shiftPeriod(before, 1);
}

// What a report shows for each marketplace in a month: the last good read,
// or why there's none.
export async function readStatements(
	db: Db,
	period: Period,
): Promise<{ results: StatementResult[]; readAt: Record<string, Date> }> {
	const rows = await db
		.select()
		.from(marketplaceStatements)
		.where(eq(marketplaceStatements.period, periodText(period)));
	const readAt: Record<string, Date> = {};
	const results = STATEMENT_CHANNELS.map((channel): StatementResult => {
		const row = rows.find((r) => r.channel === channel);
		if (!row?.statement)
			return { channel, state: "missing", error: row?.error ?? null };
		const parsed = statement(row.statement);
		if (parsed instanceof type.errors || parsed.channel !== channel)
			return {
				channel,
				state: "missing",
				error: "The figures saved for this month don't read; read them again",
			};
		const at = row.readAt ?? new Date(0);
		readAt[channel] = at;
		return {
			channel,
			state: "read",
			statement: parsed,
			complete: at.getTime() >= Date.parse(parsed.window.end),
			lastError:
				row.error && row.erroredAt && row.erroredAt > at ? row.error : null,
		};
	});
	return { results, readAt };
}
