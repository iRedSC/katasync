import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import {
	products,
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrders,
	purchaseOrderTracking,
	salesUnits,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { listCatalogs } from "#/purchasing/catalogs";
import { discountOf } from "#/purchasing/discount";
import { leadTimes } from "#/purchasing/forecast";
import { receivedByLine, supplierRows } from "#/purchasing/load";
import { PurchaseOrderError } from "#/purchasing/orders";
import { purchaseOrderStatus } from "#/purchasing/status";
import {
	monthlySpend,
	type OrderedLine,
	poCents,
	spendOf,
	topBought,
} from "#/purchasing/supplier-stats";
import { leadTimeOf } from "./suppliers";

const DAY = 24 * 60 * 60 * 1000;
const yearAgo = (now: Date) => new Date(now.getTime() - 365 * DAY);
// How far back "top selling" looks, as reorder's demand does.
const SELLING_DAYS = 90;

// PO lines matching `where`, with the discounts in force on each.
async function orderedLines(db: Db, where: SQL | undefined) {
	const [lines, discounts] = await Promise.all([
		db
			.select({
				lineId: purchaseOrderLines.id,
				purchaseOrderId: purchaseOrders.id,
				supplierId: purchaseOrders.supplierId,
				status: purchaseOrders.status,
				sentAt: purchaseOrders.sentAt,
				productId: purchaseOrderLines.productId,
				quantity: purchaseOrderLines.quantity,
				packSize: purchaseOrderLines.packSize,
				unitCost: purchaseOrderLines.unitCost,
			})
			.from(purchaseOrderLines)
			.innerJoin(
				purchaseOrders,
				eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
			)
			.where(where),
		db
			.select({
				lineId: purchaseOrderDiscounts.lineId,
				units: purchaseOrderDiscounts.units,
				percent: purchaseOrderDiscounts.percent,
				amount: purchaseOrderDiscounts.amount,
			})
			.from(purchaseOrderDiscounts)
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.id, purchaseOrderDiscounts.lineId),
			)
			.innerJoin(
				purchaseOrders,
				eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
			)
			.where(and(where, isNull(purchaseOrderDiscounts.removedAt)))
			.orderBy(purchaseOrderDiscounts.id),
	]);
	const byLine = new Map<number, OrderedLine["discounts"]>();
	for (const d of discounts.map(discountOf))
		byLine.set(d.lineId, [...(byLine.get(d.lineId) ?? []), d]);
	return lines.map(
		({ lineId, ...l }): OrderedLine => ({
			...l,
			discounts: byLine.get(lineId) ?? [],
		}),
	);
}

const bought = inArray(purchaseOrders.status, ["sent", "closed"]);

// Every supplier for the suppliers list: what it sells, the catalogs it
// carries, what we spent with it this past year, and when we last sent it
// a PO.
export const listSupplierTable = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const now = new Date();
		const [rows, lead, catalogs, lines, last, drafts] = await Promise.all([
			supplierRows(db),
			leadTimes(db),
			listCatalogs(db),
			orderedLines(db, and(bought, gte(purchaseOrders.sentAt, yearAgo(now)))),
			db
				.select({
					supplierId: purchaseOrders.supplierId,
					at: sql<Date>`max(${purchaseOrders.sentAt})`.mapWith(
						purchaseOrders.sentAt,
					),
				})
				.from(purchaseOrders)
				.where(bought)
				.groupBy(purchaseOrders.supplierId),
			db
				.select({
					id: purchaseOrders.id,
					supplierId: purchaseOrders.supplierId,
				})
				.from(purchaseOrders)
				.where(inArray(purchaseOrders.status, ["draft", "suggested"])),
		]);
		return rows.map((r) => {
			const id = r.supplier.id;
			return {
				...r,
				leadTime: leadTimeOf(lead, id),
				catalogs: catalogs
					.filter((c) => c.suppliers.some((s) => s.id === id))
					.map(({ id, name, photoId }) => ({ id, name, photoId })),
				spendYear: spendOf(lines.filter((l) => l.supplierId === id)).cents,
				lastSentAt: last.find((l) => l.supplierId === id)?.at ?? null,
				draftId: drafts.find((d) => d.supplierId === id)?.id ?? null,
			};
		});
	},
);

export type SupplierTableRow = Awaited<
	ReturnType<typeof listSupplierTable>
>[number];

// One supplier's page: its details, the catalogs it carries, what we've
// bought from it, its POs, and how its products sell.
export const getSupplierDetail = createServerFn({ method: "GET" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data: { id } }) => {
		const db = getDb();
		const now = new Date();
		const received = receivedByLine(db);
		const [[supplier], lead, catalogs, lines, orders, packages, selling] =
			await Promise.all([
				db.select().from(suppliers).where(eq(suppliers.id, id)),
				leadTimes(db, [id]),
				listCatalogs(db),
				orderedLines(
					db,
					and(
						eq(purchaseOrders.supplierId, id),
						ne(purchaseOrders.status, "cancelled"),
					),
				),
				db
					.select({
						id: purchaseOrders.id,
						status: purchaseOrders.status,
						sentAt: purchaseOrders.sentAt,
						expectedAt: purchaseOrders.expectedAt,
						closedAt: purchaseOrders.closedAt,
						createdAt: purchaseOrders.createdAt,
						lines: sql<number>`count(${purchaseOrderLines.id})::int`,
						ordered: sql<number>`coalesce(sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize}), 0)::int`,
						received: sql<number>`coalesce(sum(least(coalesce(${received.units}, 0), ${purchaseOrderLines.quantity}) * ${purchaseOrderLines.packSize}), 0)::int`,
					})
					.from(purchaseOrders)
					.leftJoin(
						purchaseOrderLines,
						eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id),
					)
					.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
					.where(eq(purchaseOrders.supplierId, id))
					.groupBy(purchaseOrders.id)
					.orderBy(desc(purchaseOrders.id)),
				db
					.select({
						purchaseOrderId: purchaseOrderTracking.purchaseOrderId,
						arrived: sql<number>`count(*) filter (where ${purchaseOrderTracking.status} = 'DELIVERED')::int`,
						total: sql<number>`count(*)::int`,
					})
					.from(purchaseOrderTracking)
					.innerJoin(
						purchaseOrders,
						eq(purchaseOrders.id, purchaseOrderTracking.purchaseOrderId),
					)
					.where(eq(purchaseOrders.supplierId, id))
					.groupBy(purchaseOrderTracking.purchaseOrderId),
				// What it sells, by units sold lately. Tool sets count as parts.
				db
					.select({
						productId: supplierOffers.productId,
						cheapest: supplierOffers.cheapest,
						units: sql<number>`coalesce(sum(${salesUnits.units}), 0)::int`,
					})
					.from(supplierOffers)
					.leftJoin(
						salesUnits,
						and(
							eq(salesUnits.productId, supplierOffers.productId),
							gte(
								salesUnits.placedAt,
								new Date(now.getTime() - SELLING_DAYS * DAY),
							),
						),
					)
					.where(eq(supplierOffers.supplierId, id))
					.groupBy(supplierOffers.productId, supplierOffers.cheapest)
					.orderBy(desc(sql`3`))
					.limit(10),
			]);
		if (!supplier) throw new PurchaseOrderError("No such supplier");

		const totals = poCents(lines);
		const pos = orders.map((o) => {
			const p = packages.find((x) => x.purchaseOrderId === o.id);
			return {
				...o,
				cents: totals.get(o.id) ?? 0,
				shows: purchaseOrderStatus({
					...o,
					packages: { arrived: p?.arrived ?? 0, total: p?.total ?? 0 },
				}),
			};
		});
		const since = yearAgo(now);
		const byUnits = topBought(lines, "units", 8, since);
		const byCents = topBought(lines, "cents", 8, since);
		const sold = selling.filter((s) => s.units > 0);
		const ids = [
			...new Set([...byUnits, ...byCents, ...sold].map((p) => p.productId)),
		];
		const named =
			ids.length === 0
				? []
				: await db
						.select({
							id: products.id,
							sku: products.sku,
							name: products.name,
							variantName: products.variantName,
							imageUrl: products.imageUrl,
						})
						.from(products)
						.where(inArray(products.id, ids));
		const withProduct = <T extends { productId: number }>(rows: T[]) =>
			rows.flatMap((r) => {
				const product = named.find((p) => p.id === r.productId);
				return product ? [{ ...r, product }] : [];
			});

		return {
			supplier,
			leadTime: leadTimeOf(lead, id),
			catalogs: catalogs.filter((c) => c.suppliers.some((s) => s.id === id)),
			spend: { all: spendOf(lines), year: spendOf(lines, since) },
			monthly: monthlySpend(lines, now),
			open: pos.filter((o) => o.status === "draft" || o.status === "sent"),
			recent: pos
				.filter((o) => o.status === "closed" || o.status === "cancelled")
				.slice(0, 10),
			topByUnits: withProduct(byUnits),
			topByCents: withProduct(byCents),
			topSelling: withProduct(sold),
			sellingDays: SELLING_DAYS,
		};
	});

export type SupplierDetail = Awaited<ReturnType<typeof getSupplierDetail>>;
