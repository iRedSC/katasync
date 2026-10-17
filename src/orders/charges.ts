import { and, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type channel,
	type chargeKind,
	orderCharges,
	orderCostReports,
	orders,
	stores,
} from "#/db/schema";

export class ChargeError extends Error {
	name = "ChargeError";
}

type Channel = (typeof channel.enumValues)[number];

export type ReportedCharge = {
	kind: (typeof chargeKind.enumValues)[number];
	description: string;
	// Positive is money we lose, negative is money back.
	amount: number;
};

export type CostReport = {
	orderId: number;
	billedBy: Channel;
	settled: boolean;
	charges: ReportedCharge[];
	// When the marketplace was asked; defaults to now.
	fetchedAt?: Date;
};

// Saves what a marketplace says it charged on an order, replacing its
// previous report. Returns false, changing nothing, when the report on file
// should win: one fetched later (two refreshes crossing), or one already
// settled, so a fallback to unsettled figures can't undo a final statement.
export async function saveCostReport(
	db: Db,
	report: CostReport,
): Promise<boolean> {
	const charges = report.charges
		.map((c) => ({
			kind: c.kind,
			description: c.description.trim(),
			amount: Math.round(c.amount * 100) / 100,
		}))
		// Marketplaces list $0 lines; a report without them means the same.
		.filter((c) => c.amount !== 0);
	for (const c of charges) {
		if (!Number.isFinite(c.amount)) {
			throw new ChargeError(`${c.description} has no amount`);
		}
		if (!c.description) throw new ChargeError("A charge has no description");
	}
	const fetchedAt = report.fetchedAt ?? new Date();

	return db.transaction(async (tx) => {
		const [order] = await tx
			.select({
				name: orders.name,
				channel: stores.channel,
				marketplaceOrderId: orders.marketplaceOrderId,
			})
			.from(orders)
			.innerJoin(stores, eq(stores.id, orders.storeId))
			.where(eq(orders.id, report.orderId));
		if (!order) throw new ChargeError(`No order ${report.orderId}`);
		// Only the order's own store, or the marketplace it was relayed from,
		// can bill it.
		const relayedFrom = order.marketplaceOrderId?.split(":")[0];
		if (report.billedBy !== order.channel && report.billedBy !== relayedFrom) {
			throw new ChargeError(
				`${order.name} wasn't sold on ${report.billedBy}, so it can't bill it`,
			);
		}

		const saved = await tx
			.insert(orderCostReports)
			.values({
				orderId: report.orderId,
				billedBy: report.billedBy,
				settled: report.settled,
				fetchedAt,
			})
			.onConflictDoUpdate({
				target: [orderCostReports.orderId, orderCostReports.billedBy],
				set: { settled: report.settled, fetchedAt },
				setWhere: sql`${orderCostReports.fetchedAt} <= excluded.fetched_at
					and (not ${orderCostReports.settled} or excluded.settled)`,
			})
			.returning({ orderId: orderCostReports.orderId });
		if (saved.length === 0) return false;

		await tx
			.delete(orderCharges)
			.where(
				and(
					eq(orderCharges.orderId, report.orderId),
					eq(orderCharges.billedBy, report.billedBy),
				),
			);
		if (charges.length > 0) {
			await tx.insert(orderCharges).values(
				charges.map((c) => ({
					...c,
					orderId: report.orderId,
					billedBy: report.billedBy,
				})),
			);
		}
		return true;
	});
}
