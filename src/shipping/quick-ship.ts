import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatches,
	orderLines,
	orders,
	packages,
	products,
	shipments,
	stores,
} from "#/db/schema";
import { externalFulfillment, labelSource } from "#/orders/fulfillment";
import { contentsKey } from "./contents";
import { companionsOf, liveDispatches } from "./dispatch";
import type { Rate } from "./shippo";

// Orders worth more than this get the insurance step even if no item asks
// for it.
export const INSURE_ABOVE = 500;

export function needsInsurance(order: {
	total: number;
	lines: { insureWhenShipped: boolean }[];
}) {
	return (
		order.total > INSURE_ABOVE || order.lines.some((l) => l.insureWhenShipped)
	);
}

// eBay only protects a seller from "item not received" on an order this big
// if the label asked for a signature.
export const EBAY_SIGNATURE_AT = 750;

// Why these orders' labels must ask for a signature, or null if they needn't.
export function signatureRequired(
	members: { channel: string; total: number }[],
): string | null {
	return members.some(
		(o) => o.channel === "ebay" && o.total >= EBAY_SIGNATURE_AT,
	)
		? `eBay requires a signature on orders of $${EBAY_SIGNATURE_AT} or more to protect you from "item not received" cases`
		: null;
}

// Everything quick ship shows after a pin: the order, other orders to the
// same address that could share the box, and the plan for shipping it alone.
export async function orderForShipping(db: Db, pin: number) {
	const [order] = await db
		.select({
			id: orders.id,
			name: orders.name,
			pin: orders.pin,
			channel: stores.channel,
			salesChannel: orders.salesChannel,
			marketplaceOrderId: orders.marketplaceOrderId,
			externalId: orders.externalId,
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

	const external = externalFulfillment(order);
	const [live] = await liveDispatches(db, [order.id]);
	const companions =
		external || live
			? []
			: await companionsOf(db, { ...order, needsShipping: true });
	const items = companions.length
		? await db
				.select({
					orderId: orderLines.orderId,
					items: sql<number>`sum(${orderLines.quantity})::int`,
				})
				.from(orderLines)
				.where(
					inArray(
						orderLines.orderId,
						companions.map((c) => c.id),
					),
				)
				.groupBy(orderLines.orderId)
		: [];

	return {
		order,
		labelSource: labelSource(order),
		external,
		// The order's live dispatch, if it already has labels.
		liveDispatchId: live?.dispatchId ?? null,
		companions: companions.map((c) => ({
			id: c.id,
			name: c.name,
			pin: c.pin,
			customerName: c.customerName,
			items: items.find((i) => i.orderId === c.id)?.items ?? 0,
		})),
		plan: await shipmentPlan(db, [order.id]),
	};
}

// What's in the box for these orders together: their lines, the merged
// contents key, insurance, and the boxes these exact contents went out in
// last time.
export async function shipmentPlan(db: Db, orderIds: number[]) {
	const members = await db
		.select({
			id: orders.id,
			name: orders.name,
			total: orders.total,
			channel: stores.channel,
			salesChannel: orders.salesChannel,
			shipCountry: orders.shipCountry,
		})
		.from(orders)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.where(inArray(orders.id, orderIds));
	if (members.length !== new Set(orderIds).size) {
		throw new Error("One of these orders no longer exists");
	}
	const lines = await db
		.select({
			orderId: orderLines.orderId,
			sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
			title: orderLines.title,
			quantity: orderLines.quantity,
			imageUrl: products.imageUrl,
			weightGrams: products.weightGrams,
			insureWhenShipped: sql<boolean>`coalesce(${products.insureWhenShipped}, false)`,
			aerosol: sql<boolean>`coalesce(${products.aerosol}, false)`,
		})
		.from(orderLines)
		.leftJoin(products, eq(products.id, orderLines.productId))
		// A cancelled line stays at 0; there's nothing of it to pack.
		.where(
			and(inArray(orderLines.orderId, orderIds), gt(orderLines.quantity, 0)),
		)
		.orderBy(orderLines.orderId, orderLines.id);

	const key = contentsKey(lines);
	const total = members.reduce((sum, o) => sum + o.total, 0);
	const shippo = members.every((o) => labelSource(o) === "shippo");
	return {
		// In the order quick ship was given them: the pin's order first.
		orderIds,
		orderNames: orderIds.map((id) => members.find((o) => o.id === id)?.name),
		lines,
		contentsKey: key,
		total,
		// Shippo labels take insurance and a signature; TikTok's come with
		// TikTok's own shipping protection.
		extras: shippo,
		// Insurance starts at full coverage.
		insure: shippo && needsInsurance({ total, lines }),
		signatureRequired: shippo ? signatureRequired(members) : null,
		// The boxes these contents went out in last time, if ever.
		last: await lastBoxes(db, key),
		// The items' own weights, when every one is known; the box is added
		// once it's chosen.
		itemsWeightGrams: lines.every((l) => l.weightGrams !== null)
			? lines.reduce((sum, l) => sum + (l.weightGrams ?? 0) * l.quantity, 0)
			: null,
	};
}

export type ShipmentPlan = Awaited<ReturnType<typeof shipmentPlan>>;

// Every box of the latest dispatch with these contents, first box first.
async function lastBoxes(db: Db, key: string) {
	const [latest] = await db
		.select({ id: dispatches.id })
		.from(dispatches)
		// A purchase that stopped part way isn't a good example.
		.where(and(eq(dispatches.contentsKey, key), isNotNull(dispatches.boughtAt)))
		.orderBy(desc(dispatches.createdAt), desc(dispatches.id))
		.limit(1);
	if (!latest) return null;
	return db
		.select({
			packageId: shipments.packageId,
			lengthMm: shipments.lengthMm,
			widthMm: shipments.widthMm,
			heightMm: shipments.heightMm,
			weightGrams: shipments.weightGrams,
			hazmat: shipments.hazmat,
		})
		.from(shipments)
		.where(eq(shipments.dispatchId, latest.id))
		.orderBy(asc(shipments.id));
}

// Turns each box's rates into one price per service: only services offered
// for every box, costs added up, the slowest box's days. With one box this
// is just that box's rates. Buying prices each box again (see buyDispatch),
// so only the service is taken from here.
// What an extra (insurance, a signature) adds to each service: its price
// with the extra less its price without, keyed by carrier and service.
// Services only offered one way have no entry.
export function extraCosts(
	withIt: Rate[],
	without: Rate[],
): Map<string, number> {
	const keyOf = (r: Rate) => `${r.carrier}|${r.service}`;
	const before = new Map(without.map((r) => [keyOf(r), r.cost]));
	const costs = new Map<string, number>();
	for (const r of withIt) {
		const base = before.get(keyOf(r));
		if (base !== undefined)
			costs.set(keyOf(r), Math.round((r.cost - base) * 100) / 100);
	}
	return costs;
}

export function combineRates(perBox: Rate[][]): Rate[] {
	if (perBox.length === 0) return [];
	const keyOf = (r: Rate) => `${r.carrier}|${r.service}`;
	const quotes = new Map<string, Rate>();
	for (const first of perBox[0]) {
		const key = keyOf(first);
		if (quotes.has(key)) continue;
		const matches = perBox.map((rates) =>
			rates
				.filter((r) => keyOf(r) === key)
				.sort((a, b) => a.cost - b.cost)
				.at(0),
		);
		if (matches.some((m) => m === undefined)) continue;
		const found = matches as Rate[];
		const days = found.map((m) => m.days);
		quotes.set(key, {
			// One box: its own rate (TikTok buys by this service id).
			id: found.map((m) => m.id).join("+"),
			carrier: first.carrier,
			service: first.service,
			serviceName: first.serviceName,
			cost: Math.round(found.reduce((sum, m) => sum + m.cost, 0) * 100) / 100,
			days: days.some((d) => d === null)
				? null
				: Math.max(...(days as number[])),
		});
	}
	return [...quotes.values()];
}

export type ServiceHistory = {
	service: string;
	sameContents: number;
	samePackage: number;
};

// Most likely first: the service these exact contents shipped with before,
// then what this box usually ships with, then cheapest.
export function rankRates<R extends { service: string; cost: number }>(
	rates: R[],
	history: ServiceHistory[],
): R[] {
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
			sameContents: sql<number>`count(*) filter (where ${dispatches.contentsKey} = ${key})::int`,
			samePackage:
				packageId === null
					? sql<number>`0`
					: sql<number>`count(*) filter (where ${shipments.packageId} = ${packageId})::int`,
		})
		.from(shipments)
		.innerJoin(dispatches, eq(dispatches.id, shipments.dispatchId))
		.groupBy(shipments.service);
}

// The box and weight each set of contents shipped in last time, for
// printing on invoices: the first box, and how many there were. Contents
// never shipped before are left out.
export async function lastPackedFor(db: Db, keys: string[]) {
	if (keys.length === 0) return new Map<string, LastPacked>();
	const rows = await db
		.selectDistinctOn([dispatches.contentsKey], {
			contentsKey: dispatches.contentsKey,
			// The size it went in, saved box or not, and the box's name if any.
			boxName: packages.name,
			lengthMm: shipments.lengthMm,
			widthMm: shipments.widthMm,
			heightMm: shipments.heightMm,
			weightGrams: shipments.weightGrams,
			boxes: sql<number>`(select count(*) from ${shipments} s where s.dispatch_id = ${dispatches.id})::int`,
		})
		.from(dispatches)
		.innerJoin(shipments, eq(shipments.dispatchId, dispatches.id))
		.leftJoin(packages, eq(packages.id, shipments.packageId))
		.where(
			and(
				inArray(dispatches.contentsKey, keys),
				isNotNull(dispatches.boughtAt),
			),
		)
		.orderBy(
			dispatches.contentsKey,
			desc(dispatches.createdAt),
			desc(dispatches.id),
			asc(shipments.id),
		);
	return new Map(rows.map((r) => [r.contentsKey, r]));
}

export type LastPacked = {
	boxName: string | null;
	lengthMm: number;
	widthMm: number;
	heightMm: number;
	weightGrams: number;
	boxes: number;
};
