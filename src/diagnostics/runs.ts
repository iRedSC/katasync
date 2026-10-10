import { eq, lt } from "drizzle-orm";
import type { Db } from "#/db/client";
import { type channel, syncIssues, syncRuns } from "#/db/schema";

// Every sync pass records what it did, so Diagnostics can say whether each
// channel is healthy and why not, without anyone reading the worker's console.

export type Channel = (typeof channel.enumValues)[number];

// Detail rows kept per run. The run's problems count stays exact past this.
export const MAX_ISSUES_PER_RUN = 200;
// Runs older than this are deleted when a new one starts.
const KEEP_DAYS = 14;
// Error text from an API can be a whole HTML page.
const MAX_ERROR_LENGTH = 2000;

// Sync problems are written "<order or SKU>: <what went wrong>" (see
// src/orders/ingest.ts). Split, so the same problem on 600 orders reads as
// one problem with a count.
export function splitProblem(problem: string): {
	reference: string | null;
	message: string;
} {
	const at = problem.indexOf(": ");
	if (at <= 0) return { reference: null, message: problem };
	return {
		reference: problem.slice(0, at),
		message: problem.slice(at + 2),
	};
}

// The useful part of an error: its message, without stack frames, capped.
export function errorText(error: unknown) {
	const raw = error instanceof Error ? error.message : String(error);
	const text = raw
		.split("\n")
		.filter((line) => !/^\s+at\s/.test(line))
		.join("\n")
		.trim();
	return text.length > MAX_ERROR_LENGTH
		? `${text.slice(0, MAX_ERROR_LENGTH)}…`
		: text;
}

// Runs one sync pass and records it. A failure is recorded and then thrown
// again, so the caller still sees it.
export async function recordSyncRun<T extends { problems: string[] }>(
	db: Db,
	channel: Channel,
	work: () => Promise<T & { orders: number }>,
	now = () => new Date(),
): Promise<T & { orders: number }> {
	await db
		.delete(syncRuns)
		.where(
			lt(
				syncRuns.startedAt,
				new Date(now().getTime() - KEEP_DAYS * 86_400_000),
			),
		);
	const [run] = await db
		.insert(syncRuns)
		.values({ channel, startedAt: now() })
		.returning({ id: syncRuns.id });
	try {
		const result = await work();
		await db
			.update(syncRuns)
			.set({
				finishedAt: now(),
				orders: result.orders,
				problems: result.problems.length,
			})
			.where(eq(syncRuns.id, run.id));
		const kept = result.problems.slice(0, MAX_ISSUES_PER_RUN);
		if (kept.length > 0)
			await db
				.insert(syncIssues)
				.values(kept.map((p) => ({ runId: run.id, ...splitProblem(p) })));
		return result;
	} catch (error) {
		await db
			.update(syncRuns)
			.set({ finishedAt: now(), error: errorText(error) })
			.where(eq(syncRuns.id, run.id));
		throw error;
	}
}
