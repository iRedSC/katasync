import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { feedHealth, marketplaceCases } from "#/db/schema";
import type { FeedOutcome } from "#/diagnostics/feed-health";
import { openGaps, recordFeed, settleGaps } from "#/diagnostics/feed-record";
import { errorText } from "#/diagnostics/runs";
import { saveMarketplaceCase } from "#/orders/marketplace-cases";
import { accessToken } from "./ebay";
import {
	DISPUTE_SCOPE,
	EbayBudgetSpent,
	EbayReauthorization,
} from "./ebay-case-api";
import { type EbayCaseKind, fetchEbayCase, fetchEbayCases } from "./ebay-cases";

const DAY = 86_400_000;
const POST_KINDS = ["inquiry", "cancellation", "escalation"] as const;

export async function ebayCasesPass(
	db: Db,
	feed: "cases" | "disputes",
	now: Date,
	deadline: number,
): Promise<FeedOutcome> {
	const [previous] = await db
		.select()
		.from(feedHealth)
		.where(and(eq(feedHealth.channel, "ebay"), eq(feedHealth.feed, feed)));
	const credential = createHash("sha256")
		.update(process.env.EBAY_REFRESH_TOKEN ?? "")
		.digest("hex")
		.slice(0, 16);
	const authMarker = `Needs eBay re-authorization [${credential}]`;
	const outcome = await read().catch(
		(error: unknown): FeedOutcome => ({
			kind: "failed",
			error:
				error instanceof EbayReauthorization
					? `${authMarker}: run pnpm ebay:authorize for payment disputes`
					: errorText(error),
		}),
	);
	await recordFeed(db, "ebay", feed, now, outcome);
	return outcome;

	async function read(): Promise<FeedOutcome> {
		let token: string | undefined;
		if (feed === "disputes") {
			if (
				previous?.state === "failed" &&
				previous.detail?.startsWith(authMarker)
			)
				throw new EbayReauthorization();
			try {
				token = await accessToken(DISPUTE_SCOPE);
			} catch (error) {
				if (/invalid_scope|insufficient_scope/.test(errorText(error)))
					throw new EbayReauthorization();
				throw error;
			}
		}
		const kinds: readonly EbayCaseKind[] =
			feed === "cases" ? POST_KINDS : ["dispute"];
		const problems: string[] = [];
		const open = await db
			.select()
			.from(marketplaceCases)
			.where(
				and(
					eq(marketplaceCases.billedBy, "ebay"),
					inArray(marketplaceCases.kind, [...kinds]),
					ne(marketplaceCases.waitingOn, "nobody"),
				),
			)
			.orderBy(marketplaceCases.syncedAt);
		// Half the budget at most, oldest first, so discovery always runs.
		const recheckUntil = Date.now() + (deadline - Date.now()) / 2;
		for (const row of open) {
			const kind = kinds.find((kind) => kind === row.kind);
			if (!kind) continue;
			let found: Awaited<ReturnType<typeof fetchEbayCase>>;
			try {
				found = await fetchEbayCase(
					kind,
					row.externalId,
					recheckUntil,
					token,
					{
						creationDate: row.requestedAt,
						inquiryId: kind === "inquiry" ? row.externalId : undefined,
						cancelId: kind === "cancellation" ? row.externalId : undefined,
						caseId: kind === "escalation" ? row.externalId : undefined,
						paymentDisputeId: kind === "dispute" ? row.externalId : undefined,
						orderId: row.orderExternalId ?? undefined,
					},
					{ respondBy: row.respondBy },
				);
			} catch (error) {
				if (error instanceof EbayBudgetSpent) break;
				throw error;
			}
			await saveMarketplaceCase(db, "ebay", found);
			problems.push(...found.problems);
		}
		let through = previous?.readThrough ?? new Date(now.getTime() - 60 * DAY);
		const reach = new Date(now.getTime() - 540 * DAY);
		if (through < reach) {
			await settleGaps(
				db,
				"ebay",
				feed,
				{ kind: "unread", from: through, until: reach },
				[
					{
						from: through,
						until: reach,
						detail: "eBay cases exceed the 18-month API history limit",
					},
				],
			);
			through = reach;
		}
		let from = new Date(Math.max(reach.getTime(), through.getTime() - DAY));
		const before = through;
		try {
			while (from < now && Date.now() < deadline) {
				const until = new Date(
					Math.min(from.getTime() + 7 * DAY, now.getTime()),
				);
				for (const kind of kinds)
					for await (const found of fetchEbayCases(
						kind,
						from,
						until,
						deadline,
						token,
					)) {
						await saveMarketplaceCase(db, "ebay", found);
						problems.push(...found.problems);
					}
				through = until;
				from = until;
			}
		} catch (error) {
			if (through <= before || error instanceof EbayReauthorization)
				throw error;
			problems.push(errorText(error));
		}
		for (const gap of await openGaps(db, "ebay", feed))
			problems.push(gap.detail);
		return through >= now
			? { kind: "read", problems, readThrough: through }
			: { kind: "catching_up", problems, readThrough: through };
	}
}
