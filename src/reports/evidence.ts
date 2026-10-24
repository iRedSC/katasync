import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orderCostReports, orderProfit, orders } from "#/db/schema";

export const FEE_EVIDENCE = [
	"settled",
	"reported",
	"aged_out",
	"estimated",
] as const;
export type FeeEvidence = (typeof FEE_EVIDENCE)[number];

type FeesStatus = (typeof orderProfit.$inferSelect)["feesStatus"];
type LabelsStatus = (typeof orderProfit.$inferSelect)["labelsStatus"];
type Marketplace = (typeof orderProfit.$inferSelect)["soldOn"];

export function feeEvidence(o: {
	feesStatus: FeesStatus;
	settled: boolean;
}): FeeEvidence {
	switch (o.feesStatus) {
		case "estimated":
			return "estimated";
		case "reported":
			return o.settled ? "settled" : "reported";
		case "final":
			return o.settled ? "settled" : "aged_out";
	}
}

export type EvidenceGroup = {
	soldOn: Marketplace;
	feesStatus: FeesStatus;
	settled: boolean;
	labelsStatus: LabelsStatus;
	costKnown: boolean;
	taxRead: boolean;
	orders: number;
	fees: number;
};

export type EvidenceRow = {
	soldOn: Marketplace;
	orders: number;
	fees: Record<FeeEvidence, { orders: number; amount: number }>;
	labelsMissing: number;
	labelsStandIn: number;
	labelsAwaiting: number;
	costUnknown: number;
	taxUnknown: number;
};

const MARKETPLACES: Marketplace[] = ["shopify", "amazon", "ebay", "tiktok"];
const cents = (n: number) => Math.round(n * 100) / 100;

function emptyRow(soldOn: Marketplace): EvidenceRow {
	return {
		soldOn,
		orders: 0,
		fees: {
			settled: { orders: 0, amount: 0 },
			reported: { orders: 0, amount: 0 },
			aged_out: { orders: 0, amount: 0 },
			estimated: { orders: 0, amount: 0 },
		},
		labelsMissing: 0,
		labelsStandIn: 0,
		labelsAwaiting: 0,
		costUnknown: 0,
		taxUnknown: 0,
	};
}

export function foldEvidence(groups: EvidenceGroup[]): EvidenceRow[] {
	const rows = new Map<Marketplace, EvidenceRow>();
	for (const g of groups) {
		const row = rows.get(g.soldOn) ?? emptyRow(g.soldOn);
		rows.set(g.soldOn, row);
		const bucket = row.fees[feeEvidence(g)];
		bucket.orders += g.orders;
		bucket.amount = cents(bucket.amount + g.fees);
		row.orders += g.orders;
		if (g.labelsStatus === "missing") row.labelsMissing += g.orders;
		if (g.labelsStatus === "stand_in") row.labelsStandIn += g.orders;
		if (g.labelsStatus === "awaiting") row.labelsAwaiting += g.orders;
		if (!g.costKnown) row.costUnknown += g.orders;
		if (!g.taxRead) row.taxUnknown += g.orders;
	}
	return MARKETPLACES.flatMap((m) => rows.get(m) ?? []);
}

export async function readEvidence(
	db: Db,
	window: { start: Date; end: Date },
): Promise<EvidenceRow[]> {
	const p = orderProfit;
	const r = orderCostReports;
	const settled = sql<boolean>`exists (select 1 from ${r} where ${r.orderId} = ${p.orderId} and ${r.billedBy} = ${p.soldOn} and ${r.settled})`;
	const taxRead = sql<boolean>`(${orders.taxRemittedBy} is not null)`;
	const groups = await db
		.select({
			soldOn: p.soldOn,
			feesStatus: p.feesStatus,
			settled,
			labelsStatus: p.labelsStatus,
			costKnown: p.costKnown,
			taxRead,
			orders: sql<number>`count(*)::int`,
			fees: sql<number>`coalesce(sum(${p.fees}), 0)::float8`,
		})
		.from(p)
		.innerJoin(orders, eq(orders.id, p.orderId))
		.where(and(gte(p.placedAt, window.start), lt(p.placedAt, window.end)))
		.groupBy(sql`1, 2, 3, 4, 5, 6`)
		.orderBy(sql`1, 2, 3, 4, 5, 6`);
	return foldEvidence(groups);
}
