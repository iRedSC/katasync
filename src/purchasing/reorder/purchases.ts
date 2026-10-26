import { and, eq, ne, notExists, notInArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderLines,
	purchaseOrders,
	supplierOffers,
} from "#/db/schema";
import { priceAt } from "#/purchasing/bulk";
import { breaksByOffer, bulkPricesOf } from "#/purchasing/bulk-prices";
import { type CheaperAt, needsOf, reorderBreakdown } from "./breakdown";
import { daysUntilReorder, fillToMax } from "./quantity";
import {
	readiness,
	type SuggestedLine,
	type SupplierSuggestion,
} from "./suggested";

export type RecommendedLine = SuggestedLine & {
	// "now": it needs ordering today but doesn't go on POs by itself (see
	// ordersItself). Otherwise the days until it would need ordering anyway.
	due: "now" | number;
	// What its line shows once added, so the PO can show it before the server
	// has it.
	kind: Breakdown["kind"];
	barcode: string | null;
	stockRange: Breakdown["range"];
	why: Breakdown["why"];
	// Another supplier sells it for less, so suggestions put it on theirs.
	cheaperAt: CheaperAt | null;
};

// What a PO's suggestions are worked out with (its Reorder dialog).
// coverDays null follows the supplier's.
export type SuggestionSettings = {
	coverDays: number | null;
	excludedCatalogs: number[];
	includePricier: boolean;
};

export const DEFAULT_SETTINGS: SuggestionSettings = {
	coverDays: null,
	excludedCatalogs: [],
	includePricier: false,
};

// A supplier's products planned as bought from it under a PO's settings:
// what it sells in the catalogs not left out. Products already on another
// supplier's open draft are left out too: now that a draft can take what
// another supplier sells for less, two drafts suggesting one product would
// order it twice.
async function plannedFrom(
	db: Db,
	supplierId: number,
	settings: SuggestionSettings,
	now: Date,
) {
	const sold = await db
		.select({ productId: supplierOffers.productId })
		.from(supplierOffers)
		.where(
			and(
				eq(supplierOffers.supplierId, supplierId),
				settings.excludedCatalogs.length > 0
					? notInArray(supplierOffers.catalogId, settings.excludedCatalogs)
					: undefined,
				notExists(
					db
						.select({ one: sql`1` })
						.from(purchaseOrderLines)
						.innerJoin(
							purchaseOrders,
							eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
						)
						.where(
							and(
								eq(purchaseOrderLines.productId, supplierOffers.productId),
								eq(purchaseOrders.status, "draft"),
								ne(purchaseOrders.supplierId, supplierId),
							),
						),
				),
			),
		);
	const plans = await reorderBreakdown(db, {
		now,
		productIds: sold.map((r) => r.productId),
		from: { supplierId, coverDays: settings.coverDays },
	});
	return plans.filter((p) => p.supplier?.supplierId === supplierId);
}

// Whether a planned product goes on its PO's suggestion by itself: it's
// below what it sold over the PO's cover days, it's the kind that orders
// itself, and this supplier is the cheapest, or the PO takes pricier ones
// too. A product not counted yet has quantity 0.
const suggests = (plan: Breakdown, settings: SuggestionSettings) =>
	plan.line.quantity > 0 &&
	plan.ordersItself &&
	(plan.cheapest || settings.includePricier);

// What a supplier's PO is suggested under its settings.
export async function suggestionFor(
	db: Db,
	supplierId: number,
	settings: SuggestionSettings,
	now = new Date(),
): Promise<SuggestedLine[]> {
	const plans = await plannedFrom(db, supplierId, settings, now);
	return plans.filter((p) => suggests(p, settings)).map((p) => p.line);
}

type Breakdown = Awaited<ReturnType<typeof reorderBreakdown>>[number];

// A supplier's products worth adding to its PO, each at the quantity that
// fills it to its max. First the ones that need ordering today but its
// suggestion doesn't take: they don't go on POs by themselves, or another
// supplier sells them for less (cheaperAt says who). Then those same kinds
// that don't need ordering yet but will within its cover days, soonest first,
// since ordering them now saves a second shipment.
// Products in `except` (already on the draft) and dormant C items (see
// reorderBreakdown) are left out, as are products not counted yet.
export async function recommendedAdditions(
	db: Db,
	supplierId: number,
	except: Set<number>,
	settings: SuggestionSettings = DEFAULT_SETTINGS,
	now = new Date(),
): Promise<RecommendedLine[]> {
	const plans = await plannedFrom(db, supplierId, settings, now);
	return plans
		.flatMap((plan): RecommendedLine[] => {
			const { line, input } = plan;
			if (except.has(line.productId) || plan.dormant || plan.notCounted)
				return [];
			const due = recommendedDue(plan, settings);
			const quantity = fillToMax(input, plan.max);
			if (due === null || quantity === 0) return [];
			return [
				{
					...line,
					quantity,
					due,
					kind: plan.kind,
					barcode: plan.barcode,
					stockRange: plan.range,
					why: plan.why,
					cheaperAt: plan.cheaperAt,
				},
			];
		})
		.sort((a, b) => dueOrder(a.due) - dueOrder(b.due));
}

// When a product is due, if that makes it worth recommending: now if it
// needs ordering but its suggestion won't take it, else within cover days.
function recommendedDue(
	plan: Breakdown,
	settings: SuggestionSettings,
): RecommendedLine["due"] | null {
	const { line, input } = plan;
	if (suggests(plan, settings)) return null;
	if (line.quantity > 0) return "now";
	const days = daysUntilReorder(input);
	return days === null || days > input.coverDays ? null : days;
}

const dueOrder = (due: RecommendedLine["due"]) => (due === "now" ? -1 : due);

// What each supplier should be sent today: what needs ordering among the
// products that go on POs by themselves (see ordersItself), each from its
// cheapest supplier, topped up to what sold over that supplier's cover days. Computed fresh from
// sales, stock, and open POs rather than stored, so it never goes stale.
export async function suggestPurchases(
	db: Db,
	now = new Date(),
): Promise<SupplierSuggestion[]> {
	const [breakdown, drafts] = await Promise.all([
		reorderBreakdown(db, { now }),
		db
			.select({ id: purchaseOrders.id, supplierId: purchaseOrders.supplierId })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.status, "draft")),
	]);

	const needs = needsOf(breakdown.filter((p) => p.ordersItself));
	const breaks = breaksByOffer(
		await bulkPricesOf(
			db,
			needs.map((n) => n.productId),
		),
	);
	const bySupplier = new Map<number, SupplierSuggestion>();
	for (const {
		supplierId,
		supplierName,
		minimumOrder,
		criticalThreshold,
		...need
	} of needs) {
		// At the bulk price its quantity reaches, as its PO line will be, so
		// the total weighs against the supplier's minimum as it'll be sent.
		const list = breaks.get(`${need.productId}:${supplierId}`);
		const line = list
			? {
					...need,
					unitCost: priceAt(
						{ cost: need.unitCost, breaks: list },
						need.quantity,
					),
				}
			: need;
		let s = bySupplier.get(supplierId);
		if (!s) {
			s = {
				supplierId,
				supplierName,
				minimumOrder,
				criticalThreshold,
				lines: [],
				total: 0,
				unpriced: 0,
				critical: 0,
				readiness: "waiting",
				draftId: drafts.find((d) => d.supplierId === supplierId)?.id ?? null,
			};
			bySupplier.set(supplierId, s);
		}
		s.lines.push(line);
		if (line.critical) s.critical++;
		if (line.unitCost === null) s.unpriced++;
		else s.total += line.quantity * line.unitCost;
	}

	const result = [...bySupplier.values()];
	for (const s of result) {
		s.total = Math.round(s.total * 100) / 100;
		s.readiness = readiness(s);
	}
	// Order soon first, then ready, then the biggest orders.
	const rank = { soon: 0, ready: 1, waiting: 2 } as const;
	return result.sort(
		(a, b) => rank[a.readiness] - rank[b.readiness] || b.total - a.total,
	);
}
