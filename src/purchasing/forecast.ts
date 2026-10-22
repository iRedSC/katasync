import {
	and,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	locations,
	movements,
	orderLines,
	orders,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	suppliers,
} from "#/db/schema";
import type { AbcClass } from "#/inventory/abc";
import { isOurs } from "#/inventory/locations";
import { soldByDay } from "#/inventory/sales";

// What reorder knows about a product's demand, from the last DEMAND_DAYS.
//
// Days a product sat at zero sell nothing, which says nothing about demand,
// so demand is units sold over the days it was in stock: a product out for
// half the window isn't read as selling half as fast. The spread of daily
// sales on those days sizes its safety stock.

// Sales from this many days back set each product's demand.
export const DEMAND_DAYS = 90;

// Demand is never spread over fewer days than this, so a product in stock
// for two days that sold once isn't read as selling every other day.
export const MIN_DEMAND_DAYS = 14;

export type Forecast = {
	// Units a day while in stock.
	dailyDemand: number;
	// How much a day's sales swing around that (standard deviation).
	dailySd: number;
	// Days of the window it was in stock (or sold, or before the ledger began).
	inStockDays: number;
};

export const NO_FORECAST: Forecast = {
	dailyDemand: 0,
	dailySd: 0,
	inStockDays: 0,
};

// A product's forecast from its days, oldest first. A day counts when the
// product was in stock or sold anyway (oversold), since either way a buyer
// could order it.
export function forecastOf(
	days: { units: number; inStock: boolean }[],
): Forecast {
	const open = days.filter((d) => d.inStock || d.units > 0);
	if (open.length === 0) return NO_FORECAST;
	const total = open.reduce((sum, d) => sum + d.units, 0);
	const mean = total / open.length;
	const variance =
		open.length < 2
			? 0
			: open.reduce((sum, d) => sum + (d.units - mean) ** 2, 0) / open.length;
	return {
		dailyDemand: total / Math.max(open.length, MIN_DEMAND_DAYS),
		dailySd: Math.sqrt(variance),
		inStockDays: open.length,
	};
}

// How sure we want to be of not running out before the next delivery, by
// class: A 98%, B 95%, C 90%. Unclassed products get C's. Each is the z score
// for that share of a normal curve.
export const SERVICE_LEVELS: Record<AbcClass, { share: number; z: number }> = {
	A: { share: 0.98, z: 2.054 },
	B: { share: 0.95, z: 1.645 },
	C: { share: 0.9, z: 1.282 },
};

// Units held beyond what the lead time should use, so a busy stretch while
// a PO is on its way doesn't empty the shelf: z times the daily swing, over
// the lead time (swings partly cancel out, hence the square root). Never more
// than the lead time's own demand: one contractor buying 30 at once shouldn't
// have us stocking for a crowd of them.
export function safetyStock(
	f: Forecast,
	abc: AbcClass | null,
	leadTimeDays: number,
) {
	const { z } = SERVICE_LEVELS[abc ?? "C"];
	return Math.ceil(
		Math.min(
			z * f.dailySd * Math.sqrt(leadTimeDays),
			f.dailyDemand * leadTimeDays,
		),
	);
}

const DAY = 86_400_000;
const dayOf = (t: Date) => t.toISOString().slice(0, 10);

// The window demand is read over: whole UTC days, from the first instant of
// the oldest to the first instant of tomorrow. Start is inclusive, end is
// exclusive. Direct sales, set sales and the days a forecast rebuilds all
// read this one window, so a number on screen and the explanation for it
// always cover the same sales.
export type DemandWindow = { start: Date; end: Date };

export function demandWindow(now = new Date()): DemandWindow {
	const today = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	return {
		start: new Date(today - (DEMAND_DAYS - 1) * DAY),
		end: new Date(today + DAY),
	};
}

// Units sold per product inside the window, counted as soldSince counts them
// for reorder (no FBA, tool sets as their parts). Built from soldByDay, so a
// day adds up the same way it does in the forecast.
export async function soldInWindow(db: Db, window: DemandWindow) {
	const endDay = dayOf(window.end);
	const units = new Map<number, number>();
	for (const s of await soldByDay(db, window.start)) {
		if (s.day >= endDay) continue;
		units.set(s.productId, (units.get(s.productId) ?? 0) + s.units);
	}
	return units;
}

// Tool sets sold inside the window, as sets rather than their parts.
// Cancelled and FBA orders are left out, as reorder counts.
export async function setsSoldIn(db: Db, window: DemandWindow) {
	const rows = await db
		.select({
			productId: orderLines.productId,
			units: sql<number>`sum(${orderLines.quantity})::int`,
		})
		.from(orderLines)
		.innerJoin(orders, eq(orders.id, orderLines.orderId))
		.innerJoin(products, eq(products.id, orderLines.productId))
		.where(
			and(
				eq(products.kind, "bundle"),
				gte(orders.placedAt, window.start),
				lt(orders.placedAt, window.end),
				isNull(orders.cancelledAt),
				eq(orders.fulfilledByChannel, false),
			),
		)
		.groupBy(orderLines.productId);
	return new Map(
		rows.flatMap((r) =>
			r.productId === null ? [] : [[r.productId, r.units] as const],
		),
	);
}

// Every stocked product's forecast. Stock on each day of the window is
// rebuilt from the ledger alone, in one query so it reads one moment: what
// had moved on our own shelves before the window, then each day's movements
// on top. (Starting from today's stock_levels in a separate query could pair
// a receipt that landed in between with a balance that doesn't have it yet.)
// Days before the ledger's first movement can't be rebuilt, so they count as
// in stock, which is what demand assumed before this.
export async function forecasts(
	db: Db,
	now = new Date(),
): Promise<Map<number, Forecast>> {
	const { start } = demandWindow(now);
	const days = Array.from({ length: DEMAND_DAYS }, (_, i) =>
		dayOf(new Date(start.getTime() + i * DAY)),
	);
	const [sales, ledgerRows] = await Promise.all([
		soldByDay(db, start),
		// day is null for everything before the window. firstAt is each group's
		// earliest movement; the ledger's first is the least of them. Every row
		// is on our shelves, so FBA history can't move the boundary.
		db
			.select({
				productId: movements.productId,
				day: sql<
					string | null
				>`case when ${movements.createdAt} < ${start} then null else to_char(${movements.createdAt} at time zone 'UTC', 'YYYY-MM-DD') end`,
				delta: sql<number>`sum(${movements.delta})::int`,
				firstAt: sql<string | null>`min(${movements.createdAt})`,
			})
			.from(movements)
			// Both our shelves, so a transfer between them nets to nothing.
			.innerJoin(locations, eq(locations.id, movements.locationId))
			.where(isOurs)
			.groupBy(sql`1`, sql`2`),
	]);
	const firstAt = ledgerRows.reduce<number | null>((first, r) => {
		if (r.firstAt === null) return first;
		const t = new Date(r.firstAt).getTime();
		return first === null || t < first ? t : first;
	}, null);
	const ledgerDay = firstAt === null ? null : dayOf(new Date(firstAt));

	const sold = new Map<number, Map<string, number>>();
	for (const s of sales) {
		const m = sold.get(s.productId) ?? new Map<string, number>();
		m.set(s.day, s.units);
		sold.set(s.productId, m);
	}
	const before = new Map<number, number>();
	const moved = new Map<number, Map<string, number>>();
	for (const mv of ledgerRows) {
		if (mv.day === null) {
			before.set(mv.productId, mv.delta);
			continue;
		}
		const m = moved.get(mv.productId) ?? new Map<string, number>();
		m.set(mv.day, mv.delta);
		moved.set(mv.productId, m);
	}

	const result = new Map<number, Forecast>();
	for (const id of new Set([
		...sold.keys(),
		...before.keys(),
		...moved.keys(),
	])) {
		const units = sold.get(id);
		const deltas = moved.get(id);
		// End-of-day stock, walking forward from before the window.
		let stock = before.get(id) ?? 0;
		const series = days.map((day) => {
			stock += deltas?.get(day) ?? 0;
			return {
				units: units?.get(day) ?? 0,
				inStock: ledgerDay === null || day < ledgerDay || stock > 0,
			};
		});
		result.set(id, forecastOf(series));
	}
	return result;
}

// A lead time measured from at least this many received POs replaces the
// supplier's typed one.
export const MIN_MEASURED_POS = 3;
// The latest this many received POs are measured, so it follows a supplier
// that got faster or slower.
const MEASURED_POS = 5;

export type LeadTime = {
	// What the supplier's settings say.
	configured: number;
	// Days from sending a PO to its first delivery: the median of the latest
	// received POs, or null until there are enough.
	measured: { days: number; pos: number } | null;
	// What reorder uses: measured when there is one.
	days: number;
};

// The median, rounded up, of whole days from sent to first delivery, at least
// a day. Null below MIN_MEASURED_POS.
export function measuredLeadTime(daysEach: number[]) {
	if (daysEach.length < MIN_MEASURED_POS) return null;
	const sorted = [...daysEach].sort((a, b) => a - b);
	const mid = sorted.length / 2;
	const median =
		sorted.length % 2
			? sorted[Math.floor(mid)]
			: (sorted[mid - 1] + sorted[mid]) / 2;
	return { days: Math.max(1, Math.ceil(median)), pos: sorted.length };
}

// Each supplier's lead time. A delivery is the first receipt on any of a
// PO's lines that wasn't undone. Only each supplier's latest MEASURED_POS
// deliveries are read, ranked in SQL.
export async function leadTimes(
	db: Db,
	supplierIds?: number[],
): Promise<Map<number, LeadTime>> {
	const undo = alias(purchaseOrderReceipts, "undo");
	const ranked = db
		.select({
			supplierId: purchaseOrders.supplierId,
			sentAt: purchaseOrders.sentAt,
			firstAt: sql<string>`min(${purchaseOrderReceipts.createdAt})`.as(
				"first_at",
			),
			latest:
				sql<number>`row_number() over (partition by ${purchaseOrders.supplierId} order by ${purchaseOrders.sentAt} desc, ${purchaseOrders.id} desc)`.as(
					"latest",
				),
		})
		.from(purchaseOrders)
		.innerJoin(
			purchaseOrderLines,
			eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id),
		)
		.innerJoin(
			purchaseOrderReceipts,
			eq(purchaseOrderReceipts.lineId, purchaseOrderLines.id),
		)
		.leftJoin(undo, eq(undo.undoesId, purchaseOrderReceipts.id))
		.where(
			and(
				isNotNull(purchaseOrders.sentAt),
				isNull(purchaseOrderReceipts.undoesId),
				isNull(undo.id),
				supplierIds
					? inArray(purchaseOrders.supplierId, supplierIds)
					: undefined,
			),
		)
		.groupBy(purchaseOrders.id)
		.as("ranked");
	const [configured, delivered] = await Promise.all([
		db
			.select({ id: suppliers.id, leadTimeDays: suppliers.leadTimeDays })
			.from(suppliers)
			.where(supplierIds ? inArray(suppliers.id, supplierIds) : undefined),
		db.select().from(ranked).where(lte(ranked.latest, MEASURED_POS)),
	]);
	const bySupplier = new Map<number, number[]>();
	for (const d of delivered) {
		if (!d.sentAt) continue;
		const list = bySupplier.get(d.supplierId) ?? [];
		list.push((new Date(d.firstAt).getTime() - d.sentAt.getTime()) / DAY);
		bySupplier.set(d.supplierId, list);
	}
	return new Map(
		configured.map((s) => {
			const measured = measuredLeadTime(bySupplier.get(s.id) ?? []);
			return [
				s.id,
				{
					configured: s.leadTimeDays,
					measured,
					days: measured?.days ?? s.leadTimeDays,
				},
			];
		}),
	);
}
