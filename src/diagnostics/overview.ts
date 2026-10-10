import { and, desc, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	shipments,
	stores,
	syncIssues,
	syncRuns,
} from "#/db/schema";
import { emailConfigured } from "#/purchasing/email";
import { channelEnv, missingEnv, type SyncedChannel } from "./checks";
import {
	channelHealth,
	groupIssues,
	hintFor,
	hintForIssue,
	workerAlive,
} from "./health";

// Everything Diagnostics shows, read in one go. Server only.

const RECENT_RUNS = 15;

export async function diagnosticsOverview(db: Db, now = new Date()) {
	const channels = await Promise.all(
		(Object.keys(channelEnv) as SyncedChannel[]).map((c) =>
			channelOverview(db, c, now),
		),
	);
	const [[{ lastStartedAt }], handoffs, unmapped] = await Promise.all([
		db.select({ lastStartedAt: max(syncRuns.startedAt) }).from(syncRuns),
		failedHandoffs(db),
		unmappedSkus(db),
	]);
	const shippoKey = process.env.SHIPPO_API_KEY;
	return {
		worker: {
			alive: workerAlive(lastStartedAt, now),
			lastStartedAt,
		},
		channels,
		handoffs,
		unmapped,
		services: {
			shippo: {
				configured: Boolean(shippoKey),
				test: shippoKey?.startsWith("shippo_test_") ?? false,
			},
			email: {
				configured: emailConfigured(),
				from: process.env.PO_EMAIL_FROM ?? null,
			},
		},
	};
}

export type DiagnosticsOverview = Awaited<
	ReturnType<typeof diagnosticsOverview>
>;

async function channelOverview(db: Db, channel: SyncedChannel, now: Date) {
	const missing = missingEnv(channelEnv[channel]);
	const [runs, [lastSuccess]] = await Promise.all([
		db
			.select()
			.from(syncRuns)
			.where(eq(syncRuns.channel, channel))
			.orderBy(desc(syncRuns.startedAt))
			.limit(RECENT_RUNS),
		db
			.select({ at: syncRuns.finishedAt })
			.from(syncRuns)
			.where(
				and(
					eq(syncRuns.channel, channel),
					isNotNull(syncRuns.finishedAt),
					isNull(syncRuns.error),
				),
			)
			.orderBy(desc(syncRuns.startedAt))
			.limit(1),
	]);
	const status = channelHealth({
		configured: missing.length === 0,
		runs,
		lastSuccessAt: lastSuccess?.at ?? null,
		now,
	});
	// Problems from the latest finished run: what's still going wrong now.
	const latest = runs.find((r) => r.finishedAt !== null);
	const issues = latest
		? groupIssues(
				await db
					.select({
						reference: syncIssues.reference,
						message: syncIssues.message,
					})
					.from(syncIssues)
					.where(eq(syncIssues.runId, latest.id)),
			).map((g) => ({ ...g, hint: hintForIssue(g.message) }))
		: [];
	const hintSource =
		status.latestError ??
		(missing.length > 0 ? `Set ${missing.join(", ")}` : null);
	return {
		channel,
		...status,
		lastSuccessAt: lastSuccess?.at ?? null,
		missing,
		hint: hintSource ? hintFor(channel, hintSource) : null,
		issues,
		// Issue rows are capped per run; this is the exact count.
		issueCount: latest?.problems ?? 0,
		runs: runs.map((r) => ({
			id: r.id,
			startedAt: r.startedAt,
			finishedAt: r.finishedAt,
			orders: r.orders,
			problems: r.problems,
			error: r.error,
		})),
	};
}

// Labels whose tracking never reached the marketplace, so the customer
// wasn't told and the order may still show unshipped there.
function failedHandoffs(db: Db) {
	return db
		.select({
			shipmentId: shipments.id,
			orderId: orders.id,
			orderName: orders.name,
			channel: stores.channel,
			trackingNumber: shipments.trackingNumber,
			error: shipments.channelError,
			createdAt: shipments.createdAt,
		})
		.from(shipments)
		.innerJoin(orders, eq(orders.id, shipments.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(
			and(
				isNotNull(shipments.channelError),
				isNull(shipments.channelSentAt),
				isNull(shipments.voidedAt),
				eq(shipments.test, false),
			),
		)
		.orderBy(desc(shipments.createdAt))
		.limit(50);
}

// SKUs sold that match no product. `missed` counts orders that should have
// taken stock and didn't; the rest are history from before the store's
// stockFrom, or shipped by the marketplace.
function unmappedSkus(db: Db) {
	return db
		.select({
			store: stores.name,
			channel: stores.channel,
			sku: orderLines.sku,
			orders: sql<number>`count(distinct ${orders.id})::int`,
			units: sql<number>`sum(${orderLines.quantity})::int`,
			missed: sql<number>`count(distinct ${orders.id}) filter (where ${orders.placedAt} >= ${stores.stockFrom} and not ${orders.fulfilledByChannel} and ${orders.cancelledAt} is null)::int`,
			lastPlacedAt: max(orders.placedAt),
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(and(isNull(orderLines.productId), isNotNull(orderLines.sku)))
		.groupBy(stores.id, orderLines.sku)
		.orderBy(
			sql`count(distinct ${orders.id}) filter (where ${orders.placedAt} >= ${stores.stockFrom} and not ${orders.fulfilledByChannel} and ${orders.cancelledAt} is null) desc`,
			sql`count(distinct ${orders.id}) desc`,
		)
		.limit(50);
}

// For the nav badge: channels failing or stale, the worker being down, and
// tracking that didn't reach a marketplace. Unmapped SKUs have their own home
// on Listings, so they don't count here.
export async function diagnosticsAttention(db: Db, now = new Date()) {
	const o = await diagnosticsOverview(db, now);
	// With the worker down every channel goes stale; that's one problem.
	const stuck = o.channels.filter(
		(c) => c.health === "failing" || (o.worker.alive && c.health === "stale"),
	);
	return (
		(o.worker.alive ? 0 : 1) + stuck.length + (o.handoffs.length > 0 ? 1 : 0)
	);
}
