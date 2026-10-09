import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderLines,
	orders,
	packages,
	products,
	shipments,
	stores,
} from "#/db/schema";
import { contentsKey } from "./contents";
import type { Rate } from "./shippo";

// Orders worth more than this get the insurance step even if no item asks
// for it.
export const INSURE_ABOVE = 500;

// Where an order's label comes from. Marketplaces that sell their own labels
// keep that protection; Shippo covers the rest.
export type LabelSource = "shippo" | "amazon" | "tiktok";

export function labelSource(order: {
	channel: string;
	salesChannel: string | null;
}): LabelSource {
	if (order.channel === "amazon") return "amazon";
	if (order.salesChannel === "TikTok") return "tiktok";
	return "shippo";
}

export function needsInsurance(order: {
	total: number;
	lines: { insureWhenShipped: boolean }[];
}) {
	return (
		order.total > INSURE_ABOVE || order.lines.some((l) => l.insureWhenShipped)
	);
}

// Everything quick ship shows after a pin: the order, what's in it, and the
// box and weight these exact contents shipped in last time.
export async function orderForShipping(db: Db, pin: number) {
	const [order] = await db
		.select({
			id: orders.id,
			name: orders.name,
			pin: orders.pin,
			channel: stores.channel,
			salesChannel: orders.salesChannel,
			total: orders.total,
			customerName: orders.customerName,
			shipAddress1: orders.shipAddress1,
			shipAddress2: orders.shipAddress2,
			shipCity: orders.shipCity,
			shipRegion: orders.shipRegion,
			shipPostalCode: orders.shipPostalCode,
			shipCountry: orders.shipCountry,
			shipPhone: orders.shipPhone,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(eq(orders.pin, pin));
	if (!order) return null;

	const lines = await db
		.select({
			sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
			title: orderLines.title,
			quantity: orderLines.quantity,
			imageUrl: products.imageUrl,
			weightGrams: products.weightGrams,
			insureWhenShipped: sql<boolean>`coalesce(${products.insureWhenShipped}, false)`,
		})
		.from(orderLines)
		.leftJoin(products, eq(products.id, orderLines.productId))
		.where(eq(orderLines.orderId, order.id))
		.orderBy(orderLines.id);

	const key = contentsKey(lines);
	const [last] = await db
		.select({
			packageId: shipments.packageId,
			lengthMm: shipments.lengthMm,
			widthMm: shipments.widthMm,
			heightMm: shipments.heightMm,
			weightGrams: shipments.weightGrams,
		})
		.from(shipments)
		.where(eq(shipments.contentsKey, key))
		.orderBy(desc(shipments.createdAt))
		.limit(1);
	const [{ labels }] = await db
		.select({ labels: sql<number>`count(*)::int` })
		.from(shipments)
		.where(eq(shipments.orderId, order.id));

	return {
		order,
		lines,
		contentsKey: key,
		labelSource: labelSource(order),
		insure: needsInsurance({ total: order.total, lines }),
		// The box and weight these contents shipped in last time, if ever.
		last: last ?? null,
		// The items' own weights, when every one is known; the box is added
		// once it's chosen.
		itemsWeightGrams: lines.every((l) => l.weightGrams !== null)
			? lines.reduce((sum, l) => sum + (l.weightGrams ?? 0) * l.quantity, 0)
			: null,
		labelsBought: labels,
	};
}

export type ServiceHistory = {
	service: string;
	sameContents: number;
	samePackage: number;
};

// Most likely first: the service these exact contents shipped with before,
// then what this box usually ships with, then cheapest.
export function rankRates(rates: Rate[], history: ServiceHistory[]): Rate[] {
	const score = new Map(
		history.map((h) => [h.service, h.sameContents * 10 + h.samePackage]),
	);
	return [...rates].sort(
		(a, b) =>
			(score.get(b.service) ?? 0) - (score.get(a.service) ?? 0) ||
			a.cost - b.cost,
	);
}

export async function serviceHistory(
	db: Db,
	key: string,
	packageId: number | null,
): Promise<ServiceHistory[]> {
	return db
		.select({
			service: shipments.service,
			sameContents: sql<number>`count(*) filter (where ${shipments.contentsKey} = ${key})::int`,
			samePackage:
				packageId === null
					? sql<number>`0`
					: sql<number>`count(*) filter (where ${shipments.packageId} = ${packageId})::int`,
		})
		.from(shipments)
		.groupBy(shipments.service);
}

// Picks a free 3-digit pin for a new box.
export async function freePackagePin(db: Db) {
	const used = new Set(
		(await db.select({ pin: packages.pin }).from(packages)).map((p) => p.pin),
	);
	for (let pin = 100; pin <= 999; pin++) if (!used.has(pin)) return pin;
	throw new Error("Every box pin is taken");
}
