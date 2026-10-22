import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import {
	purchaseOrderDiscounts,
	purchaseOrderLines,
	type purchaseOrderStatus,
	purchaseOrders,
	purchaseOrderTracking,
	suppliers,
} from "#/db/schema";
import { discountOf, lineCents } from "#/purchasing/discount";
import { countUnfiled } from "#/purchasing/inbox/ingest";
import { backOrderedUnits, receivedByLine } from "#/purchasing/load";
import { readyToOrder, suggestPurchases } from "#/purchasing/reorder";

type Status = (typeof purchaseOrderStatus.enumValues)[number];

// Suggestions ready to order, every PO still open or incoming, plus the latest
// finished ones.
export const listPurchasing = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const received = receivedByLine(db);
		const [suggestions, active, finished, supplierNames, unfiled] =
			await Promise.all([
				suggestPurchases(db),
				// Not capped: an old PO still out for delivery stays listed however
				// many finished ones follow it.
				orderRows(db, received, ["draft", "sent"]),
				orderRows(db, received, ["closed", "cancelled"]).limit(30),
				db
					.select({ id: suppliers.id, name: suppliers.name })
					.from(suppliers)
					.orderBy(suppliers.name),
				countUnfiled(db),
			]);
		const orders = [...active, ...finished];
		const ids = orders.map((o) => o.id);
		// Totals above are before discounts; take those off line by line.
		const [off, packages] = await Promise.all([
			discountsOff(db, ids),
			packagesOf(db, ids),
		]);
		for (const o of orders) o.total -= off.get(o.id) ?? 0;
		const withPackages = orders.map((o) => ({
			...o,
			packages: packages.get(o.id) ?? NO_PACKAGES,
		}));
		// Open: drafts still being put together. Incoming: sent, waiting on
		// deliveries.
		const open = withPackages.filter((o) => o.status === "draft");
		const incoming = withPackages.filter((o) => o.status === "sent");
		const done = withPackages.filter(
			(o) => o.status === "closed" || o.status === "cancelled",
		);
		return {
			ready: readyToOrder(suggestions),
			open,
			incoming,
			done,
			suppliers: supplierNames,
			// Supplier emails waiting to be put on a PO.
			emailsToFile: unfiled.toFile,
		};
	},
);

export type PurchasingList = Awaited<ReturnType<typeof listPurchasing>>;

type Packages = { arrived: number; total: number; trouble: boolean };
const NO_PACKAGES: Packages = { arrived: 0, total: 0, trouble: false };

// The tracked packages on each of these POs: how many the carrier says were
// delivered, and whether any came back or went wrong. Counted apart from the
// lines so the join can't multiply their sums.
async function packagesOf(db: Db, purchaseOrderIds: number[]) {
	const of = new Map<number, Packages>();
	if (purchaseOrderIds.length === 0) return of;
	const rows = await db
		.select({
			purchaseOrderId: purchaseOrderTracking.purchaseOrderId,
			arrived: sql<number>`count(*) filter (where ${purchaseOrderTracking.status} = 'DELIVERED')::int`,
			total: sql<number>`count(*)::int`,
			trouble: sql<boolean>`bool_or(${purchaseOrderTracking.status} in ('RETURNED', 'FAILURE'))`,
		})
		.from(purchaseOrderTracking)
		.where(inArray(purchaseOrderTracking.purchaseOrderId, purchaseOrderIds))
		.groupBy(purchaseOrderTracking.purchaseOrderId);
	for (const { purchaseOrderId, ...p } of rows)
		of.set(purchaseOrderId, { ...p, trouble: p.trouble === true });
	return of;
}

// The POs in these statuses, newest first, with their totals. The caller
// caps the rows when it needs to.
function orderRows(
	db: Db,
	received: ReturnType<typeof receivedByLine>,
	statuses: Status[],
) {
	return (
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
				backOrdered: backOrderedUnits(received),
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
			.where(inArray(purchaseOrders.status, statuses))
			.groupBy(purchaseOrders.id, suppliers.id)
			.orderBy(desc(purchaseOrders.id))
	);
}

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
