import { and, eq, ne, sql } from "drizzle-orm";
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
	// The marketplace says the order needs no label: picked up, or sold in
	// person.
	noLabel?: boolean;
	// Its label figures are a stand-in until it catches up (Shopify's
	// timeline, before its labels report has the order).
	labelsPending?: boolean;
	// False when the label figures are only a fallback, with no authoritative
	// label section behind them. Authoritative label charges already on file are
	// kept instead; fees and refunds still update. Defaults to true.
	labelsAuthoritative?: boolean;
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

		// A fallback doesn't replace the authoritative label charges on file.
		const keepLabels =
			report.labelsAuthoritative === false &&
			(await hasAuthoritativeLabels(tx, report.orderId, report.billedBy));
		const labelsPending = !keepLabels && (report.labelsPending ?? false);

		const saved = await tx
			.insert(orderCostReports)
			.values({
				orderId: report.orderId,
				billedBy: report.billedBy,
				settled: report.settled,
				noLabel: report.noLabel ?? false,
				labelsPending,
				fetchedAt,
			})
			.onConflictDoUpdate({
				target: [orderCostReports.orderId, orderCostReports.billedBy],
				set: {
					settled: report.settled,
					noLabel: report.noLabel ?? false,
					labelsPending,
					fetchedAt,
				},
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
					keepLabels ? ne(orderCharges.kind, "label") : undefined,
				),
			);
		const kept = keepLabels
			? charges.filter((c) => c.kind !== "label")
			: charges;
		if (kept.length > 0) {
			await tx.insert(orderCharges).values(
				kept.map((c) => ({
					...c,
					orderId: report.orderId,
					billedBy: report.billedBy,
				})),
			);
		}
		return true;
	});
}

// Whether the report on file has label charges from an authoritative label
// section, one saved with labelsPending false. An authoritative zero has no
// rows to show it, so a fallback still replaces it.
async function hasAuthoritativeLabels(
	db: Db,
	orderId: number,
	billedBy: Channel,
) {
	const [found] = await db
		.select({ id: orderCharges.id })
		.from(orderCharges)
		.innerJoin(
			orderCostReports,
			and(
				eq(orderCostReports.orderId, orderCharges.orderId),
				eq(orderCostReports.billedBy, orderCharges.billedBy),
			),
		)
		.where(
			and(
				eq(orderCharges.orderId, orderId),
				eq(orderCharges.billedBy, billedBy),
				eq(orderCharges.kind, "label"),
				eq(orderCostReports.labelsPending, false),
			),
		)
		.limit(1);
	return found !== undefined;
}
