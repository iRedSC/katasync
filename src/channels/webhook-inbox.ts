import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { webhookInbox } from "#/db/webhook-schema";
import type { WebhookChannel } from "./webhooks";

export const CLAIM_LIMIT = 10;
const LEASE_SECONDS = 120;
const BUSY_RETRY = sql`interval '30 seconds'`;
const MAX_BACKOFF = sql`interval '60 minutes'`;
const ERROR_CHARS = 500;

export type Ingest = (
	channel: WebhookChannel,
	orderId: string,
) => Promise<boolean>;

export type Claim = {
	id: number;
	channel: WebhookChannel;
	orderId: string;
	generation: number;
	leaseToken: string;
};

type Outcome =
	| { kind: "done" }
	| { kind: "busy" }
	| { kind: "failed"; error: string };

export type Settled = "done" | "pending" | "lost";

export function digestOf(body: string) {
	return createHash("sha256").update(body).digest("hex");
}

export async function acceptWebhook(
	db: Db,
	channel: WebhookChannel,
	orderId: string,
	body: string,
) {
	const eventDigest = digestOf(body);
	await db
		.insert(webhookInbox)
		.values({ channel, orderId, eventDigest })
		.onConflictDoUpdate({
			target: [webhookInbox.channel, webhookInbox.orderId],
			set: {
				eventDigest,
				generation: sql`${webhookInbox.generation} + 1`,
				nextAttemptAt: sql`now()`,
				failures: 0,
				lastError: null,
				lastErrorAt: null,
			},
			setWhere: sql`${webhookInbox.eventDigest} <> ${eventDigest}`,
		});
}

export async function claimDue(db: Db, limit: number): Promise<Claim[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > CLAIM_LIMIT)
		throw new Error(`Claim limit must be between 1 and ${CLAIM_LIMIT}`);
	const leaseToken = randomUUID();
	const { rows } = await db.execute<{
		id: number;
		channel: WebhookChannel;
		orderId: string;
		generation: number;
	}>(sql`
		update webhook_inbox
		set lease_token = ${leaseToken},
			lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
		where id in (
			select id from webhook_inbox
			where next_attempt_at <= now()
				and (lease_expires_at is null or lease_expires_at <= now())
			order by next_attempt_at
			limit ${limit}
			for update skip locked
		)
		returning id, channel, order_id as "orderId", generation
	`);
	return rows.map((row) => ({ ...row, leaseToken }));
}

export async function settle(
	db: Db,
	claim: Claim,
	outcome: Outcome,
): Promise<Settled> {
	if (outcome.kind === "done") {
		const removed = await db
			.delete(webhookInbox)
			.where(
				and(
					eq(webhookInbox.id, claim.id),
					eq(webhookInbox.leaseToken, claim.leaseToken),
					eq(webhookInbox.generation, claim.generation),
				),
			)
			.returning({ id: webhookInbox.id });
		if (removed.length > 0) return "done";
	}
	const sameGeneration = sql`${webhookInbox.generation} = ${claim.generation}`;
	const retryIn =
		outcome.kind === "busy"
			? BUSY_RETRY
			: outcome.kind === "failed"
				? sql`least(interval '1 minute' * power(2, least(${webhookInbox.failures}, 6)), ${MAX_BACKOFF})`
				: undefined;
	const released = await db
		.update(webhookInbox)
		.set({
			leaseToken: null,
			leaseExpiresAt: null,
			...(retryIn && {
				nextAttemptAt: sql`case when ${sameGeneration} then now() + ${retryIn} else ${webhookInbox.nextAttemptAt} end`,
			}),
			...(outcome.kind === "failed" && {
				failures: sql`case when ${sameGeneration} then ${webhookInbox.failures} + 1 else ${webhookInbox.failures} end`,
				lastError: sql`case when ${sameGeneration} then ${outcome.error} else ${webhookInbox.lastError} end`,
				lastErrorAt: sql`case when ${sameGeneration} then now() else ${webhookInbox.lastErrorAt} end`,
			}),
		})
		.where(
			and(
				eq(webhookInbox.id, claim.id),
				eq(webhookInbox.leaseToken, claim.leaseToken),
			),
		)
		.returning({ id: webhookInbox.id });
	return released.length > 0 ? "pending" : "lost";
}

export function ingestWith(db: Db): Ingest {
	return async (channel, orderId) => {
		const { ingestWebhookOrder } = await import("#/channels/sync");
		return ingestWebhookOrder(db, channel, orderId);
	};
}

async function attempt(claim: Claim, ingest: Ingest): Promise<Outcome> {
	try {
		return (await ingest(claim.channel, claim.orderId))
			? { kind: "done" }
			: { kind: "busy" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "failed", error: message.slice(0, ERROR_CHARS) };
	}
}

export async function drainDue(db: Db, ingest: Ingest, limit = CLAIM_LIMIT) {
	const report = { claimed: 0, done: 0, busy: 0, failed: 0, lost: 0 };
	const claims = await claimDue(db, limit);
	report.claimed = claims.length;
	for (const claim of claims) {
		const outcome = await attempt(claim, ingest);
		report[outcome.kind] += 1;
		if ((await settle(db, claim, outcome)) === "lost") report.lost += 1;
	}
	return report;
}

export async function backlogSummary(db: Db) {
	const [totals] = await db
		.select({
			pending: sql<number>`count(*)::int`,
			leased: sql<number>`(count(*) filter (where ${webhookInbox.leaseExpiresAt} > now()))::int`,
			failing: sql<number>`(count(*) filter (where ${webhookInbox.failures} > 0))::int`,
			oldestAgeSeconds: sql<
				number | null
			>`extract(epoch from now() - min(${webhookInbox.eventAt}))::int`,
		})
		.from(webhookInbox);
	const [latest] = await db
		.select({
			message: webhookInbox.lastError,
			at: webhookInbox.lastErrorAt,
		})
		.from(webhookInbox)
		.where(isNotNull(webhookInbox.lastErrorAt))
		.orderBy(desc(webhookInbox.lastErrorAt))
		.limit(1);
	return {
		...totals,
		lastError: latest?.message && latest.at ? latest : null,
	};
}
