import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import {
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrders,
	suppliers,
} from "#/db/schema";
import { discountOf, lineCents } from "#/purchasing/discount";
import { unfiledForList } from "#/purchasing/inbox/unfiled";
import { receivedByLine } from "#/purchasing/load";
import { readyToOrder, suggestPurchases } from "#/purchasing/reorder";

// Suggestions ready to order, and every PO still open plus the latest finished ones.
export const listPurchasing = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const received = receivedByLine(db);
		const [suggestions, orders, supplierNames, inbox] = await Promise.all([
			suggestPurchases(db),
			db
				.select({
					id: purchaseOrders.id,
					status: purchaseOrders.status,
					supplierId: suppliers.id,
					supplierName: suppliers.name,
					supplierEmail: suppliers.email,
					sentAt: purchaseOrders.sentAt,
					expectedAt: purchaseOrders.expectedAt,
					closedAt: purchaseOrders.closedAt,
					createdAt: purchaseOrders.createdAt,
					lines: sql<number>`count(${purchaseOrderLines.id})::int`,
					// Counted in the product itself, so cases and eaches add up.
					ordered: sql<number>`coalesce(sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize}), 0)::int`,
					received: sql<number>`coalesce(sum(least(coalesce(${received.units}, 0), ${purchaseOrderLines.quantity}) * ${purchaseOrderLines.packSize}), 0)::int`,
					total: sql<number>`coalesce(sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.unitCost}), 0)::float`,
				})
				.from(purchaseOrders)
				.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
				.leftJoin(
					purchaseOrderLines,
					eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id),
				)
				.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
				// Suggested POs show as their suggestion, under Ready to order.
				.where(ne(purchaseOrders.status, "suggested"))
				.groupBy(purchaseOrders.id, suppliers.id)
				.orderBy(desc(purchaseOrders.id))
				.limit(200),
			db
				.select({ id: suppliers.id, name: suppliers.name })
				.from(suppliers)
				.orderBy(suppliers.name),
			unfiledForList(db),
		]);
		// Totals above are before discounts; take those off line by line.
		const off = await discountsOff(
			db,
			orders.map((o) => o.id),
		);
		for (const o of orders) o.total -= off.get(o.id) ?? 0;
		// Open: drafts still being put together. Incoming: sent, waiting on
		// deliveries.
		const open = orders.filter((o) => o.status === "draft");
		const incoming = orders.filter((o) => o.status === "sent");
		const done = orders
			.filter((o) => o.status === "closed" || o.status === "cancelled")
			.slice(0, 30);
		return {
			ready: readyToOrder(suggestions),
			open,
			incoming,
			done,
			suppliers: supplierNames,
			// Supplier emails waiting to be put on a PO.
			inbox,
		};
	},
);

export type PurchasingList = Awaited<ReturnType<typeof listPurchasing>>;

// Dollars of discounts on each of these POs.
async function discountsOff(db: Db, purchaseOrderIds: number[]) {
	const off = new Map<number, number>();
	if (purchaseOrderIds.length === 0) return off;
	const rows = await db
		.select({
			lineId: purchaseOrderLines.id,
			purchaseOrderId: purchaseOrderLines.purchaseOrderId,
			quantity: purchaseOrderLines.quantity,
			unitCost: purchaseOrderLines.unitCost,
			units: purchaseOrderDiscounts.units,
			percent: purchaseOrderDiscounts.percent,
			amount: purchaseOrderDiscounts.amount,
		})
		.from(purchaseOrderDiscounts)
		.innerJoin(
			purchaseOrderLines,
			eq(purchaseOrderLines.id, purchaseOrderDiscounts.lineId),
		)
		.where(
			and(
				inArray(purchaseOrderLines.purchaseOrderId, purchaseOrderIds),
				isNull(purchaseOrderDiscounts.removedAt),
			),
		)
		.orderBy(purchaseOrderDiscounts.id);
	const lines = new Map<
		number,
		ReturnType<typeof discountOf<(typeof rows)[number]>>[]
	>();
	for (const r of rows.map(discountOf))
		lines.set(r.lineId, [...(lines.get(r.lineId) ?? []), r]);
	for (const discounts of lines.values()) {
		const [line] = discounts;
		const before = lineCents(line, []);
		const after = lineCents(line, discounts);
		if (before === null || after === null) continue;
		off.set(
			line.purchaseOrderId,
			(off.get(line.purchaseOrderId) ?? 0) + (before - after) / 100,
		);
	}
	return off;
}

// "POs ready" on Home: the same list as "Ready to order".
export const countPosReady = createServerFn({ method: "GET" }).handler(
	async () => readyToOrder(await suggestPurchases(getDb())).length,
);
