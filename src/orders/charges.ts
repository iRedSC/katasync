import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type channel,
	type chargeKind,
	type labelAuthority,
	orderCharges,
	orderCostReports,
	orders,
	stores,
} from "#/db/schema";
import { alertRebill, crossesLarge } from "#/inbox/rebill-alerts";

export class ChargeError extends Error {
	name = "ChargeError";
}

type Channel = (typeof channel.enumValues)[number];
type LabelAuthority = (typeof labelAuthority.enumValues)[number];

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
	// label section behind them. Authoritative label figures already on file are
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

		// A fallback doesn't replace the authoritative label figures on file,
		// even $0 ones, which have no charge rows.
		const keepLabels =
			report.labelsAuthoritative === false &&
			(await labelAuthorityOnFile(tx, report.orderId, report.billedBy)) ===
				"authoritative";
		const labelsPending = !keepLabels && (report.labelsPending ?? false);
		const authority: LabelAuthority =
			keepLabels || (report.labelsAuthoritative !== false && !labelsPending)
				? "authoritative"
				: "fallback";

		const saved = await tx
			.insert(orderCostReports)
			.values({
				orderId: report.orderId,
				billedBy: report.billedBy,
				settled: report.settled,
				noLabel: report.noLabel ?? false,
				labelsPending,
				labelAuthority: authority,
				fetchedAt,
			})
			.onConflictDoUpdate({
				target: [orderCostReports.orderId, orderCostReports.billedBy],
				set: {
					settled: report.settled,
					noLabel: report.noLabel ?? false,
					labelsPending,
					labelAuthority: authority,
					fetchedAt,
				},
				setWhere: sql`${orderCostReports.fetchedAt} <= excluded.fetched_at
					and (not ${orderCostReports.settled} or excluded.settled)`,
			})
			.returning({ orderId: orderCostReports.orderId });
		if (saved.length === 0) return false;

		const rebilledBefore = await postageSum(
			tx,
			report.orderId,
			report.billedBy,
		);
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
		const rebilled = await postageSum(tx, report.orderId, report.billedBy);
		if (crossesLarge(rebilledBefore.adjusted, rebilled.adjusted))
			await alertRebill(tx, {
				key: `order:${report.orderId}:${report.billedBy}`,
				orderId: report.orderId,
				orderName: order.name,
				market: report.billedBy,
				marketplaceId: order.marketplaceOrderId?.split(":")[1] ?? null,
				amount: rebilled.adjusted,
				label: rebilled.label,
			});
		return true;
	});
}

// What a marketplace billed on an order's labels, and re-billed on them.
async function postageSum(db: Db, orderId: number, billedBy: Channel) {
	const [row] = await db
		.select({
			label: sql<number>`coalesce(sum(${orderCharges.amount}) filter (where ${orderCharges.kind} = 'label'), 0)::float8`,
			adjusted: sql<number>`coalesce(sum(${orderCharges.amount}) filter (where ${orderCharges.kind} = 'postage_adjustment'), 0)::float8`,
		})
		.from(orderCharges)
		.where(
			and(
				eq(orderCharges.orderId, orderId),
				eq(orderCharges.billedBy, billedBy),
				inArray(orderCharges.kind, ["label", "postage_adjustment"]),
			),
		);
	return row ?? { label: 0, adjusted: 0 };
}

// Where the label figures of the report on file came from, if there is one.
async function labelAuthorityOnFile(
	db: Db,
	orderId: number,
	billedBy: Channel,
): Promise<LabelAuthority | undefined> {
	const [found] = await db
		.select({ authority: orderCostReports.labelAuthority })
		.from(orderCostReports)
		.where(
			and(
				eq(orderCostReports.orderId, orderId),
				eq(orderCostReports.billedBy, billedBy),
			),
		);
	return found?.authority;
}
