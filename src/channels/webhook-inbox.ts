import { createHash, randomUUID } from "node:crypto";
import { type } from "arktype";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { webhookInbox } from "#/db/webhook-schema";
import type { WebhookUpdate } from "./order-update";
import type { WebhookChannel, WebhookTarget } from "./webhooks";

export const CLAIM_LIMIT = 10;
const LEASE_SECONDS = 120;
const BUSY_RETRY = sql`interval '30 seconds'`;
const MAX_BACKOFF = sql`interval '60 minutes'`;
const ERROR_CHARS = 500;

export type Ingest = (
	channel: WebhookChannel,
	target: WebhookTarget,
) => Promise<WebhookUpdate>;

export type Claim = {
	id: number;
	channel: WebhookChannel;
	target: WebhookTarget;
	generation: number;
	leaseToken: string;
};

type Outcome =
	| { kind: "done" }
	| { kind: "busy" }
	| { kind: "failed"; error: string };

export type Settled = "done" | "pending" | "lost";

// A target as webhook_inbox keys it (its order_id column): an order by its
// own id, as before targets, a case target by its kind and id. No order id
// starts with a target's kind, so the two never meet.
export const targetKey = (target: WebhookTarget) =>
	target.kind === "order" ? target.id : `${target.kind}:${target.id}`;

function targetOf(kind: WebhookTarget["kind"], key: string): WebhookTarget {
	return {
		kind,
		id: kind === "order" ? key : key.slice(kind.length + 1),
	} as WebhookTarget;
}

export function digestOf(body: string) {
	return createHash("sha256").update(body).digest("hex");
}

export async function acceptWebhook(
	db: Db,
	channel: WebhookChannel,
	target: WebhookTarget,
	body: string,
) {
	const eventDigest = digestOf(body);
	await db
		.insert(webhookInbox)
		.values({
			channel,
			target: target.kind,
			targetKey: targetKey(target),
			eventDigest,
		})
		.onConflictDoUpdate({
			target: [webhookInbox.channel, webhookInbox.targetKey],
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

const claimedRows = type({
	rows: type({
		id: "number",
		channel: "'shopify' | 'tiktok'",
		target: "'order' | 'order_returns' | 'aftersales'",
		targetKey: "string",
		generation: "number",
	}).array(),
});

export async function claimDue(db: Db, limit: number): Promise<Claim[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > CLAIM_LIMIT)
		throw new Error(`Claim limit must be between 1 and ${CLAIM_LIMIT}`);
	const leaseToken = randomUUID();
	const { rows } = claimedRows.assert(
		await db.execute(sql`
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
		returning id, channel, target, order_id as "targetKey", generation
	`),
	);
	return rows.map(({ target, targetKey, ...row }) => ({
		...row,
		target: targetOf(target, targetKey),
		leaseToken,
	}));
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
	return async (channel, target) => {
		const { ingestWebhookCase, ingestWebhookOrder } = await import(
			"#/channels/sync"
		);
		switch (target.kind) {
			case "order":
				return ingestWebhookOrder(db, channel, target.id);
			case "order_returns":
			case "aftersales":
				if (channel !== "tiktok")
					return { kind: "retry", error: `${channel} sends no case events` };
				return ingestWebhookCase(db, target);
		}
	};
}

async function attempt(claim: Claim, ingest: Ingest): Promise<Outcome> {
	try {
		const result = await ingest(claim.channel, claim.target);
		switch (result.kind) {
			case "applied":
			case "ignored":
				return { kind: "done" };
			case "busy":
				return { kind: "busy" };
			case "retry":
				return { kind: "failed", error: result.error.slice(0, ERROR_CHARS) };
		}
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
