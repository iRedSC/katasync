import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	suppliers,
} from "#/db/schema";

// A PO a product is already on, so it isn't bought twice by adding it to
// another. Suggested POs aren't here: nobody has chosen those lines yet.
export type OpenPo = {
	purchaseOrderId: number;
	status: "draft" | "sent";
	supplierName: string;
	// Single items: what's still to come on a sent PO, what's ordered on a
	// draft.
	units: number;
	// A sent PO's promised day; null when there's none or the line is
	// back-ordered.
	expectedAt: Date | null;
	backOrdered: boolean;
};

// Each product's drafts and sent POs still owing it, oldest first. A sent
// line that has all arrived is done, so it's left out.
export async function openPosOf(
	db: Db,
	productIds?: number[],
): Promise<Map<number, OpenPo[]>> {
	if (productIds?.length === 0) return new Map();
	const received = db
		.select({
			lineId: purchaseOrderReceipts.lineId,
			units: sql<number>`sum(${purchaseOrderReceipts.quantity})`.as("units"),
		})
		.from(purchaseOrderReceipts)
		.groupBy(purchaseOrderReceipts.lineId)
		.as("received");
	const rows = await db
		.select({
			productId: purchaseOrderLines.productId,
			purchaseOrderId: purchaseOrders.id,
			status: purchaseOrders.status,
			supplierName: suppliers.name,
			units: sql<number>`(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize})::int`,
			expectedAt: purchaseOrders.expectedAt,
			backOrderedAt: purchaseOrderLines.backOrderedAt,
		})
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
		.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
		.where(
			and(
				or(
					eq(purchaseOrders.status, "draft"),
					eq(purchaseOrders.status, "sent"),
				),
				productIds
					? inArray(purchaseOrderLines.productId, productIds)
					: undefined,
			),
		)
		.orderBy(purchaseOrders.id);
	const byProduct = new Map<number, OpenPo[]>();
	for (const r of rows) {
		if (r.status !== "draft" && r.status !== "sent") continue;
		if (r.units === 0) continue;
		const list = byProduct.get(r.productId) ?? [];
		list.push({
			purchaseOrderId: r.purchaseOrderId,
			status: r.status,
			supplierName: r.supplierName,
			units: r.units,
			expectedAt:
				r.status === "sent" && r.backOrderedAt === null ? r.expectedAt : null,
			backOrdered: r.backOrderedAt !== null,
		});
		byProduct.set(r.productId, list);
	}
	return byProduct;
}
