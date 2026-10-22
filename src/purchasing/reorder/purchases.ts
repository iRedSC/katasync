import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productSuppliers, purchaseOrders } from "#/db/schema";
import { needsOf, reorderBreakdown } from "./breakdown";
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
};

type Breakdown = Awaited<ReturnType<typeof reorderBreakdown>>[number];

// A supplier's products worth adding to its PO, each at the quantity that
// fills it to its max. First the ones that need ordering today but don't go
// on POs by themselves; then the ones that don't need ordering yet but will
// before its next PO would (within its cover days), soonest first, since
// ordering them now saves a second shipment. Products in `except` (already on
// the draft) and dormant C items (see reorderBreakdown) are left out, as are products
// not counted yet.
export async function recommendedAdditions(
	db: Db,
	supplierId: number,
	except: Set<number>,
	now = new Date(),
): Promise<RecommendedLine[]> {
	// Only this supplier's products are planned, so the rest aren't loaded.
	const mine = await db
		.select({ productId: productSuppliers.productId })
		.from(productSuppliers)
		.where(eq(productSuppliers.supplierId, supplierId));
	const plans = await reorderBreakdown(db, {
		now,
		productIds: mine.map((r) => r.productId),
	});
	return plans
		.flatMap((plan): RecommendedLine[] => {
			const { line, supplier, input } = plan;
			if (
				supplier?.supplierId !== supplierId ||
				except.has(line.productId) ||
				plan.dormant ||
				plan.notCounted
			)
				return [];
			const due = recommendedDue(plan);
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
				},
			];
		})
		.sort((a, b) => dueOrder(a.due) - dueOrder(b.due));
}

// When a product is due, if that makes it worth recommending: now if it
// needs ordering but its PO won't take it by itself, else within cover days.
function recommendedDue({
	line,
	input,
	ordersItself,
}: Breakdown): RecommendedLine["due"] | null {
	if (line.quantity > 0) return ordersItself ? null : "now";
	const days = daysUntilReorder(input);
	return days === null || days > input.coverDays ? null : days;
}

const dueOrder = (due: RecommendedLine["due"]) => (due === "now" ? -1 : due);

// What each supplier should be sent today: what needs ordering among the
// products that go on POs by themselves (see ordersItself). Computed fresh from
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

	const bySupplier = new Map<number, SupplierSuggestion>();
	for (const {
		supplierId,
		supplierName,
		minimumOrder,
		criticalThreshold,
		...line
	} of needsOf(breakdown.filter((p) => p.ordersItself))) {
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
