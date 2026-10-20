// Turns recorded sync runs into one word per channel, and known errors into
// what to do about them. Pure, so it's tested without a database.

import type { Channel } from "./runs";

export type Health =
	| "healthy"
	| "degraded"
	| "failing"
	| "stale"
	| "never_synced"
	| "not_connected";

// Channels sync every four hours (more often while the orders page is open),
// so four and a half hours without a good pass means something is wrong even
// if nothing failed loudly.
export const STALE_AFTER_MINUTES = 270;
// No pass of any channel in this long: the crons (or pnpm sync --watch)
// aren't running.
export const WORKER_QUIET_MINUTES = 270;

export type Run = {
	startedAt: Date;
	finishedAt: Date | null;
	problems: number;
	error: string | null;
};

const minutesAgo = (now: Date, minutes: number) =>
	new Date(now.getTime() - minutes * 60_000);

// `runs` are the latest, newest first; lastSuccessAt is when the latest good
// run finished, which may be older than all of them. A run still going (no
// finishedAt) doesn't count yet.
export function channelHealth(input: {
	configured: boolean;
	runs: Run[];
	lastSuccessAt: Date | null;
	now: Date;
}) {
	const finished = input.runs.filter((r) => r.finishedAt !== null);
	const { lastSuccessAt } = input;
	let consecutiveFailures = 0;
	for (const run of finished) {
		if (run.error === null) break;
		consecutiveFailures++;
	}
	const latest = finished[0];

	let health: Health;
	if (!input.configured) health = "not_connected";
	else if (!latest) health = "never_synced";
	else if (latest.error !== null) health = "failing";
	else if (
		!lastSuccessAt ||
		lastSuccessAt < minutesAgo(input.now, STALE_AFTER_MINUTES)
	)
		health = "stale";
	else if (latest.problems > 0) health = "degraded";
	else health = "healthy";

	return {
		health,
		consecutiveFailures,
		// When the current run of failures began: the oldest failure in it.
		failingSince:
			consecutiveFailures > 0
				? finished[consecutiveFailures - 1].startedAt
				: null,
		latestError: latest?.error ?? null,
	};
}

// The worker runs outside the app, so its only sign of life is runs starting.
export function workerAlive(lastStartedAt: Date | null, now: Date) {
	return (
		lastStartedAt !== null &&
		lastStartedAt >= minutesAgo(now, WORKER_QUIET_MINUTES)
	);
}

export type Hint = { title: string; action: string };

// Known failures, worded as what to do. Patterns come from real errors; an
// unknown error gets no hint and its text is shown as it is.
export function hintFor(channel: Channel | "shippo" | "email", error: string) {
	const env = /^Set ([A-Z_, and]+)/.exec(error);
	if (env)
		return {
			title: "Credentials are missing from the environment.",
			action: `Add ${env[1]} to .env.local (or the server's environment) and restart the sync worker.`,
		};
	if (channel === "ebay" && /login failed: 400|invalid_grant/i.test(error))
		return {
			title: "eBay refused the saved login.",
			action:
				'Check EBAY_REFRESH_TOKEN is quoted in .env.local: the token contains "#", and anything after it is cut off unquoted. eBay refresh tokens also expire after 18 months; if it\'s that old, authorize the app again.',
		};
	if (/login failed|invalid_client|unauthori[sz]ed_client|\b401\b/i.test(error))
		return {
			title: "The saved login no longer works.",
			action:
				"Run the connection check. If the token step fails, authorize again and update the refresh token.",
		};
	if (/ACCESS_DENIED|access denied|\b403\b|insufficient.*scope/i.test(error))
		return {
			title: "The app is missing a permission.",
			action:
				channel === "shopify"
					? "Run the connection check, add the missing scope in Shopify admin (Settings > Apps > Develop apps), and reinstall."
					: "Authorize the app again, approving every permission it asks for.",
		};
	if (/THROTTLED|rate limit|\b429\b|QuotaExceeded/i.test(error))
		return {
			title: "The API's rate limit was hit.",
			action: "Retries next pass.",
		};
	if (
		/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(error)
	)
		return {
			title: "Couldn't reach the API.",
			action: "Check this machine's internet. Retries next pass.",
		};
	if (
		/\b5\d\d\b|Unexpected end of JSON|invalid JSON|Unexpected token/i.test(
			error,
		)
	)
		return {
			title: "The marketplace answered with an error or a broken response.",
			action: "Retries next pass.",
		};
	return null;
}

// Problems with single orders that have a known fix.
export function hintForIssue(message: string): Hint | null {
	if (message.startsWith("no product for "))
		return {
			title: "Unmatched listing, so no stock taken.",
			action: "Match it on Listings; these orders then take stock.",
		};
	if (message === "no location to take stock from")
		return {
			title: "There's more than one location to ship from.",
			action:
				"No stock taken. Fix with a count until each store has a shipping location.",
		};
	return null;
}

// Messages that differ only by order go together, most frequent first, with
// up to `keep` references each.
export function groupIssues(
	issues: { reference: string | null; message: string }[],
	keep = 20,
) {
	const groups = new Map<
		string,
		{ message: string; count: number; references: string[] }
	>();
	for (const issue of issues) {
		let group = groups.get(issue.message);
		if (!group) {
			group = { message: issue.message, count: 0, references: [] };
			groups.set(issue.message, group);
		}
		group.count++;
		if (issue.reference && group.references.length < keep)
			group.references.push(issue.reference);
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}
