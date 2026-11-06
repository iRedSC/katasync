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
): Promise<StatementRefresh> {
	const key = { channel, period: periodText(period) };
	try {
		const read = await READERS[channel](period);
		const now = new Date();
		await db
			.insert(marketplaceStatements)
			.values({ ...key, statement: read, readAt: now })
			.onConflictDoUpdate({
				target: [marketplaceStatements.channel, marketplaceStatements.period],
				set: { statement: read, readAt: now, error: null, erroredAt: null },
			});
		return { kind: "read" };
	} catch (e) {
		const error = errorText(e);
		// Best effort: if the database is what failed, this fails too, and the
		// error still goes back to the caller.
		await db
			.insert(marketplaceStatements)
			.values({ ...key, error, erroredAt: new Date() })
			.onConflictDoUpdate({
				target: [marketplaceStatements.channel, marketplaceStatements.period],
				set: { error, erroredAt: sql`now()` },
			})
			.catch(() => {});
		return { kind: "failed", error };
	}
}

// The month so far and the one before, which keeps changing for a while
// after it ends as late postings land.
export function statementPeriods(now = new Date()): Period[] {
	const before = lastMonth(now);
	return [shiftPeriod(before, 1), before];
}

export async function refreshRecentStatements(
	db: Db,
	channel: StatementChannel,
	now = new Date(),
) {
	const results: Record<string, StatementRefresh> = {};
	for (const p of statementPeriods(now))
		results[periodText(p)] = await refreshStatement(db, channel, p);
	return results;
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
		if (row.readAt) readAt[channel] = row.readAt;
		return { channel, state: "read", statement: parsed };
	});
	return { results, readAt };
}
