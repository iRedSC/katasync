import { and, desc, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import { backlogSummary } from "#/channels/webhook-inbox";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	mcpCalls,
	orderCostChecks,
	orderLines,
	orders,
	products,
	shipments,
	stores,
	syncIssues,
	syncRuns,
} from "#/db/schema";
import { unsettledStock } from "#/orders/reconcile-stock";
import { emailConfigured } from "#/purchasing/email";
import { INBOX_ENV, inboxAddress } from "#/purchasing/inbox/graph";
import { channelEnv, missingEnv, type SyncedChannel } from "./checks";
import { dismissalKey, type IsDismissed, loadDismissals } from "./dismissals";
import {
	channelHealth,
	groupIssues,
	hintFor,
	hintForIssue,
	workerAlive,
} from "./health";

// Everything Diagnostics shows, read in one go. Server only.

const RECENT_RUNS = 15;
const UNSETTLED_ROWS = 500;

// Dismissed problems are still listed, marked `dismissed`.
export async function diagnosticsOverview(db: Db, now = new Date()) {
	const isDismissed = await loadDismissals(db);
	const channels = await Promise.all(
		(Object.keys(channelEnv) as SyncedChannel[]).map((c) =>
			channelOverview(db, c, now, isDismissed),
		),
	);
	const [
		[{ lastStartedAt }],
		handoffs,
		storefrontTracking,
		unmapped,
		claude,
		charges,
		webhooks,
	] = await Promise.all([
		db.select({ lastStartedAt: max(syncRuns.startedAt) }).from(syncRuns),
		failedHandoffs(db, isDismissed),
		storefrontTrackingFailures(db, isDismissed),
		unmappedSkus(db),
		// Changes made through /mcp (see src/mcp/log.ts).
		db
			.select()
			.from(mcpCalls)
			.orderBy(desc(mcpCalls.createdAt), desc(mcpCalls.id))
			.limit(50)
			// As text: arguments can be any JSON.
			.then((rows) =>
				rows.map((r) => ({ ...r, arguments: JSON.stringify(r.arguments) })),
			),
		chargeFailures(db, isDismissed),
		backlogSummary(db),
	]);
	const shippoKey = process.env.SHIPPO_API_KEY;
	return {
		worker: {
			alive: workerAlive(lastStartedAt, now),
			lastStartedAt,
		},
		channels,
		handoffs,
		storefrontTracking,
		unmapped,
		claude,
		charges,
		webhooks,
		services: {
			shippo: {
				configured: Boolean(shippoKey),
				test: shippoKey?.startsWith("shippo_test_") ?? false,
			},
			email: {
				configured: emailConfigured(),
				from: process.env.PO_EMAIL_FROM ?? null,
			},
			inbox: {
				address: inboxAddress(),
				missing: missingEnv(INBOX_ENV),
			},
		},
	};
}

export type DiagnosticsOverview = Awaited<
	ReturnType<typeof diagnosticsOverview>
>;

async function channelOverview(
	db: Db,
	channel: SyncedChannel,
	now: Date,
	isDismissed: IsDismissed,
) {
	const missing = missingEnv(channelEnv[channel]);
	const [runs, [lastSuccess], unsettled] = await Promise.all([
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
		unsettledStockRows(db, channel),
	]);
	const status = channelHealth({
		configured: missing.length === 0,
		runs,
		lastSuccessAt: lastSuccess?.at ?? null,
		now,
	});
	// Problems from the latest finished run: what's still going wrong now.
	const latest = runs.find((r) => r.finishedAt !== null);
	const rows = latest
		? (
				await db
					.select({
						reference: syncIssues.reference,
						message: syncIssues.message,
					})
					.from(syncIssues)
					.where(eq(syncIssues.runId, latest.id))
			).map((r) => ({
				...r,
				dismissed: isDismissed(
					dismissalKey.issue(channel, r.reference, r.message),
					r.message,
				),
				// Unmatched listings are worked from Listings, not here.
				unmatched: r.message.startsWith("no product for "),
			}))
		: [];
	const stock = unsettled.map((r) => {
		const message = `Stock not taken for ${r.sku}`;
		return {
			reference: r.orderName,
			message,
			dismissed: isDismissed(
				dismissalKey.issue(channel, r.orderName, message),
				message,
			),
			unmatched: false,
		};
	});
	const issues = [false, true].flatMap((dismissed) =>
		groupIssues(
			[...rows, ...stock].filter((r) => r.dismissed === dismissed),
		).map((g) => ({
			...g,
			dismissed,
			unmatched: g.message.startsWith("no product for "),
			hint: hintForIssue(g.message),
		})),
	);
	// Issue rows are capped per run, so what's left counts from the exact
	// total: rows not kept are neither dismissed nor known to be unmatched.
	const openIssues =
		(latest?.problems ?? 0) -
		rows.filter((r) => r.dismissed || r.unmatched).length;
	const clean = openIssues <= 0 && stock.every((r) => r.dismissed);
	const health =
		status.health === "degraded" && clean
			? "healthy"
			: status.health === "healthy" && !clean
				? "degraded"
				: status.health;
	const hintSource =
		status.latestError ??
		(missing.length > 0 ? `Set ${missing.join(", ")}` : null);
	return {
		channel,
		...status,
		health,
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

// Orders whose tracking never reached the marketplace, so the customer
// wasn't told and the order may still show unshipped there. Those still
// being retried are listed too, so a failure shows from the first refusal.
function failedHandoffs(db: Db, isDismissed: IsDismissed) {
	return db
		.select({
			dispatchId: dispatchOrders.dispatchId,
			orderId: orders.id,
			orderName: orders.name,
			channel: stores.channel,
			trackingNumber: sql<
				string | null
			>`(select string_agg(${shipments.trackingNumber}, ', ' order by ${shipments.id}) from ${shipments} where ${shipments.dispatchId} = ${dispatchOrders.dispatchId} and ${shipments.voidedAt} is null)`,
			error: dispatchOrders.channelError,
			// Set while katasync is still trying on its own.
			retryAt: dispatchOrders.channelRetryAt,
			attempts: dispatchOrders.channelAttempts,
			createdAt: dispatches.createdAt,
		})
		.from(dispatchOrders)
		.innerJoin(dispatches, eq(dispatches.id, dispatchOrders.dispatchId))
		.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(
			and(
				isNotNull(dispatchOrders.channelError),
				isNull(dispatchOrders.channelSentAt),
				// Live, and not a test: a live box that isn't a test label.
				sql`exists (select 1 from ${shipments} where ${shipments.dispatchId} = ${dispatchOrders.dispatchId} and ${shipments.voidedAt} is null and not ${shipments.test})`,
			),
		)
		.orderBy(desc(dispatches.createdAt))
		.limit(50)
		.then((rows) =>
			rows.map((r) => ({
				...r,
				dismissed: isDismissed(
					dismissalKey.handoff(r.dispatchId, r.orderId),
					r.error ?? "",
				),
			})),
		);
}

// Labels whose katasync.shippo_tracking entry on the Shopify order couldn't
// be saved or, once voided, removed. The customer was emailed either way;
// the storefront's tracking page is wrong until someone fixes it. Voided
// labels count too: the storefront would still show them.
function storefrontTrackingFailures(db: Db, isDismissed: IsDismissed) {
	return db
		.selectDistinctOn([shipments.id], {
			shipmentId: shipments.id,
			orderId: orders.id,
			orderName: orders.name,
			trackingNumber: shipments.trackingNumber,
			voided: sql<boolean>`${shipments.voidedAt} is not null`,
			error: sql<string>`${shipments.storefrontTrackingError}`,
			createdAt: shipments.createdAt,
		})
		.from(shipments)
		.innerJoin(
			dispatchOrders,
			eq(dispatchOrders.dispatchId, shipments.dispatchId),
		)
		.innerJoin(orders, eq(orders.id, dispatchOrders.orderId))
		.where(isNotNull(shipments.storefrontTrackingError))
		.orderBy(desc(shipments.id), orders.id)
		.limit(50)
		.then((rows) =>
			rows.map((r) => ({
				...r,
				dismissed: isDismissed(dismissalKey.storefront(r.shipmentId), r.error),
			})),
		);
}

// Asking a marketplace what it charged on an order that failed last time
// (src/orders/cost-refresh.ts), grouped by marketplace and error. Those
// orders keep estimated fees until it works; it's retried on its own.
// Grouped here rather than in SQL, since dismissals are per order.
async function chargeFailures(db: Db, isDismissed: IsDismissed) {
	const rows = await db
		.select({
			orderId: orderCostChecks.orderId,
			billedBy: orderCostChecks.billedBy,
			error: sql<string>`${orderCostChecks.error}`,
			checkedAt: orderCostChecks.checkedAt,
		})
		.from(orderCostChecks)
		.where(isNotNull(orderCostChecks.error));
	const groups = new Map<
		string,
		{
			billedBy: (typeof rows)[number]["billedBy"];
			error: string;
			dismissed: boolean;
			orders: number;
			lastAt: Date;
		}
	>();
	for (const r of rows) {
		const dismissed = isDismissed(
			dismissalKey.charge(r.orderId, r.billedBy),
			r.error,
		);
		const id = JSON.stringify([r.billedBy, r.error, dismissed]);
		const group = groups.get(id);
		if (!group)
			groups.set(id, {
				billedBy: r.billedBy,
				error: r.error,
				dismissed,
				orders: 1,
				lastAt: r.checkedAt,
			});
		else {
			group.orders++;
			if (r.checkedAt > group.lastAt) group.lastAt = r.checkedAt;
		}
	}
	return [...groups.values()]
		.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
		.slice(0, 40);
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

// Lines that should have taken stock and still haven't (reconcile-stock.ts).
// Read from the lines, not the latest run, so a newer clean run doesn't hide them.
function unsettledStockRows(db: Db, channel: SyncedChannel) {
	return db
		.selectDistinct({ orderName: orders.name, sku: products.sku })
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.innerJoin(products, eq(products.id, orderLines.productId))
		.where(and(eq(stores.channel, channel), unsettledStock))
		.limit(UNSETTLED_ROWS);
}

// For the nav badge: channels failing or stale, the worker being down,
// tracking that didn't reach a marketplace, and charges that couldn't be
// read. Unmapped SKUs have their own home
// on Listings, so they don't count here.
export async function diagnosticsAttention(db: Db, now = new Date()) {
	const o = await diagnosticsOverview(db, now);
	// With the worker down every channel goes stale; that's one problem.
	const stuck = o.channels.filter(
		(c) => c.health === "failing" || (o.worker.alive && c.health === "stale"),
	);
	const open = <T extends { dismissed: boolean }>(rows: T[]) =>
		rows.some((r) => !r.dismissed) ? 1 : 0;
	return (
		(o.worker.alive ? 0 : 1) +
		stuck.length +
		open(o.handoffs) +
		open(o.storefrontTracking) +
		open(o.charges) +
		(o.webhooks.failing > 0 || (o.webhooks.oldestAgeSeconds ?? 0) > 300 ? 1 : 0)
	);
}
