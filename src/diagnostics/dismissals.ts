import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dismissals,
	dispatchOrders,
	orderCostChecks,
	shipments,
	syncIssues,
	syncRuns,
} from "#/db/schema";
import type { Channel } from "./runs";

// Dismissing a problem on Diagnostics. Each thing that can fail has one key;
// a dismissal hides it while its error reads the same, so the same thing
// failing differently shows again. Groups (an error on many orders) are
// dismissed order by order, so a new order with that error shows again.

export type DismissTarget =
	| { kind: "handoff"; dispatchId: number; orderId: number }
	| { kind: "storefront"; shipmentId: number }
	| { kind: "charges"; billedBy: Channel; error: string }
	| { kind: "issue"; channel: Channel; message: string };

// The only place keys are spelled.
export const dismissalKey = {
	handoff: (dispatchId: number, orderId: number) =>
		`handoff:${dispatchId}:${orderId}`,
	storefront: (shipmentId: number) => `storefront:${shipmentId}`,
	charge: (orderId: number, billedBy: Channel) =>
		`charge:${orderId}:${billedBy}`,
	// Issues without an order or SKU are told apart by their message.
	issue: (channel: Channel, reference: string | null, message: string) =>
		`issue:${channel}:${reference ?? message}`,
};

export type IsDismissed = (key: string, error: string) => boolean;

export async function loadDismissals(db: Db): Promise<IsDismissed> {
	const rows = await db
		.select({ key: dismissals.key, error: dismissals.error })
		.from(dismissals);
	const byKey = new Map(rows.map((r) => [r.key, r.error]));
	return (key, error) => byKey.get(key) === error;
}

// What a target covers right now: each key with the error it reads.
async function covered(
	db: Db,
	target: DismissTarget,
): Promise<{ key: string; error: string }[]> {
	switch (target.kind) {
		case "handoff": {
			const [row] = await db
				.select({ error: dispatchOrders.channelError })
				.from(dispatchOrders)
				.where(
					and(
						eq(dispatchOrders.dispatchId, target.dispatchId),
						eq(dispatchOrders.orderId, target.orderId),
					),
				);
			return row?.error
				? [
						{
							key: dismissalKey.handoff(target.dispatchId, target.orderId),
							error: row.error,
						},
					]
				: [];
		}
		case "storefront": {
			const [row] = await db
				.select({ error: shipments.storefrontTrackingError })
				.from(shipments)
				.where(eq(shipments.id, target.shipmentId));
			return row?.error
				? [
						{
							key: dismissalKey.storefront(target.shipmentId),
							error: row.error,
						},
					]
				: [];
		}
		case "charges": {
			const rows = await db
				.select({ orderId: orderCostChecks.orderId })
				.from(orderCostChecks)
				.where(
					and(
						eq(orderCostChecks.billedBy, target.billedBy),
						eq(orderCostChecks.error, target.error),
					),
				);
			return rows.map((r) => ({
				key: dismissalKey.charge(r.orderId, target.billedBy),
				error: target.error,
			}));
		}
		case "issue": {
			const [latest] = await db
				.select({ id: syncRuns.id })
				.from(syncRuns)
				.where(
					and(
						eq(syncRuns.channel, target.channel),
						isNotNull(syncRuns.finishedAt),
					),
				)
				.orderBy(desc(syncRuns.startedAt))
				.limit(1);
			if (!latest) return [];
			const rows = await db
				.select({ reference: syncIssues.reference })
				.from(syncIssues)
				.where(
					and(
						eq(syncIssues.runId, latest.id),
						eq(syncIssues.message, target.message),
					),
				);
			return rows.map((r) => ({
				key: dismissalKey.issue(target.channel, r.reference, target.message),
				error: target.message,
			}));
		}
	}
}

export async function dismiss(db: Db, target: DismissTarget) {
	const rows = await covered(db, target);
	if (rows.length > 0)
		await db
			.insert(dismissals)
			.values(rows)
			.onConflictDoUpdate({
				target: dismissals.key,
				set: { error: sql`excluded.error`, dismissedAt: sql`now()` },
			});
	return { dismissed: rows.length };
}

export async function restore(db: Db, target: DismissTarget) {
	const keys = (await covered(db, target)).map((r) => r.key);
	if (keys.length > 0)
		await db.delete(dismissals).where(inArray(dismissals.key, keys));
	return { restored: keys.length };
}
