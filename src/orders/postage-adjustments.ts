import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	orderCharges,
	orderLineProfit,
	orderLines,
	orders,
	packages,
	products,
	shipmentAdjustments,
	shipments,
	stores,
} from "#/db/schema";
import { contentsKey } from "#/shipping/contents";
import { type RebillReason, rebillReason } from "#/shipping/rebill-reason";

// What carriers re-billed on labels for a size or weight other than declared
// (postage_adjustment charges), grouped so the cause can be fixed: by what was
// in the box, and by product.
//
// Amazon's labels are bought on Seller Central, so katasync has no box for
// them: Amazon names the order, not the package, and says neither why nor
// what the carrier measured. What was in the box is the closest thing to the
// box, and each re-billed order links to Seller Central, whose order page
// shows the package as declared. Labels katasync buys from Shippo do have a
// box, re-billed per label (shipment_adjustments), so those also group by
// box, with what was declared, and say why each was re-billed.

const lp = orderLineProfit;

// A label katasync bought from Shippo that's still good, joined to its
// dispatch's orders.
const liveLabel = and(
	eq(dispatchOrders.dispatchId, shipments.dispatchId),
	eq(shipments.provider, "shippo"),
	eq(shipments.test, false),
	isNull(shipments.voidedAt),
);

// Orders in the range shipped on a label that can be re-billed, one row per
// item: one katasync bought from Shippo, or one billed (or re-billed) by a
// marketplace that re-bills (one with a re-bill on record). A re-bill whose
// label never came through still counts.
export async function postageLines(db: Db, start: Date, end: Date) {
	const rebillers = db
		.selectDistinct({ billedBy: orderCharges.billedBy })
		.from(orderCharges)
		.where(eq(orderCharges.kind, "postage_adjustment"));
	const labelled = db
		.selectDistinct({ orderId: orderCharges.orderId })
		.from(orderCharges)
		.where(
			and(
				inArray(orderCharges.kind, ["label", "postage_adjustment"]),
				inArray(orderCharges.billedBy, rebillers),
			),
		);
	const shippoShipped = db
		.selectDistinct({ orderId: dispatchOrders.orderId })
		.from(shipments)
		.innerJoin(dispatchOrders, liveLabel);
	return db
		.select({
			orderId: lp.orderId,
			orderName: orders.name,
			soldOn: lp.soldOn,
			marketplaceOrderId: orders.marketplaceOrderId,
			placedAt: lp.placedAt,
			// The order's whole re-bill, and this item's share of it and of the
			// label, shared by sales as order_line_profit shares them.
			orderAdjustment: lp.orderPostageAdjustments,
			adjustment: lp.postageAdjustments,
			labels: lp.labels,
			productId: lp.productId,
			sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
			title: orderLines.title,
			name: sql<string>`coalesce(${products.name}, ${orderLines.title})`,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			quantity: lp.quantity,
			weightGrams: products.weightGrams,
			lengthMm: products.lengthMm,
			widthMm: products.widthMm,
			heightMm: products.heightMm,
		})
		.from(lp)
		.innerJoin(orders, eq(orders.id, lp.orderId))
		.innerJoin(orderLines, eq(orderLines.id, lp.lineId))
		.leftJoin(products, eq(products.id, lp.productId))
		.where(
			and(
				gte(lp.placedAt, start),
				lt(lp.placedAt, end),
				eq(lp.shipped, true),
				or(inArray(lp.orderId, labelled), inArray(lp.orderId, shippoShipped)),
			),
		);
}

export type PostageLine = Awaited<ReturnType<typeof postageLines>>[number];

export type RebilledOrder = {
	id: number;
	name: string;
	soldOn: PostageLine["soldOn"];
	// The marketplace's own ID, to open the order there.
	marketplaceId: string | null;
	placedAt: Date;
	amount: number;
	labels: number;
};

type Group = {
	// Labelled orders it was in, and how many of them were re-billed.
	orders: number;
	rebilled: RebilledOrder[];
	amount: number;
	// What the re-billed orders' labels cost to begin with.
	labels: number;
};

export type ContentsGroup = Group & {
	key: string;
	items: Pick<
		PostageLine,
		"productId" | "sku" | "name" | "variantName" | "imageUrl" | "quantity"
	>[];
};

export type ProductGroup = Group & {
	productId: number;
	sku: string | null;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	// As saved on the product, for katasync's own labels.
	weightGrams: number | null;
	box: [number, number, number] | null;
};

const byAmount = (a: Group, b: Group) =>
	b.amount - a.amount || b.rebilled.length - a.rebilled.length;
const cents = (n: number) => Math.round(n * 100) / 100;

export function groupPostage(lines: PostageLine[]) {
	const byOrder = new Map<number, PostageLine[]>();
	for (const l of lines) {
		const order = byOrder.get(l.orderId) ?? [];
		order.push(l);
		byOrder.set(l.orderId, order);
	}

	const contents = new Map<string, ContentsGroup>();
	const productGroups = new Map<number, ProductGroup>();
	let orderCount = 0;
	const rebilled: RebilledOrder[] = [];
	for (const order of byOrder.values()) {
		const first = order[0];
		orderCount++;
		const isRebilled = first.orderAdjustment !== 0;
		const entry: RebilledOrder = {
			id: first.orderId,
			name: first.orderName,
			soldOn: first.soldOn,
			marketplaceId: first.marketplaceOrderId?.split(":")[1] ?? null,
			placedAt: first.placedAt,
			amount: first.orderAdjustment,
			labels: cents(order.reduce((s, l) => s + l.labels, 0)),
		};
		if (isRebilled) rebilled.push(entry);

		const key = contentsKey(
			order.map((l) => ({ sku: l.sku, title: l.title, quantity: l.quantity })),
		);
		const group = contents.get(key) ?? {
			key,
			items: order.map((l) => ({
				productId: l.productId,
				sku: l.sku,
				name: l.name,
				variantName: l.variantName,
				imageUrl: l.imageUrl,
				quantity: l.quantity,
			})),
			orders: 0,
			rebilled: [],
			amount: 0,
			labels: 0,
		};
		group.orders++;
		if (isRebilled) {
			group.rebilled.push(entry);
			group.amount = cents(group.amount + entry.amount);
			group.labels = cents(group.labels + entry.labels);
		}
		contents.set(key, group);

		// A product counts once per order, however many lines it's on.
		const seen = new Set<number>();
		for (const l of order) {
			if (l.productId === null) continue;
			const p = productGroups.get(l.productId) ?? {
				productId: l.productId,
				sku: l.sku,
				name: l.name,
				variantName: l.variantName,
				imageUrl: l.imageUrl,
				weightGrams: l.weightGrams,
				box:
					l.lengthMm && l.widthMm && l.heightMm
						? [l.lengthMm, l.widthMm, l.heightMm]
						: null,
				orders: 0,
				rebilled: [],
				amount: 0,
				labels: 0,
			};
			if (!seen.has(l.productId)) {
				seen.add(l.productId);
				p.orders++;
				if (isRebilled) p.rebilled.push(entry);
			}
			if (isRebilled) {
				p.amount = cents(p.amount + l.adjustment);
				p.labels = cents(p.labels + l.labels);
			}
			productGroups.set(l.productId, p);
		}
	}

	const amount = cents(rebilled.reduce((s, o) => s + o.amount, 0));
	return {
		// Orders shipped on a label from a marketplace that re-bills.
		orders: orderCount,
		rebilled: rebilled.sort((a, b) => b.amount - a.amount),
		amount,
		labels: cents(rebilled.reduce((s, o) => s + o.labels, 0)),
		byContents: [...contents.values()]
			.filter((g) => g.rebilled.length > 0)
			.sort(byAmount),
		byProduct: [...productGroups.values()]
			.filter((g) => g.rebilled.length > 0)
			.sort(byAmount),
		// What re-billed orders' items without a product carry, so the
		// product groups needn't add up to the total without saying why.
		unmatched: cents(
			lines
				.filter((l) => l.productId === null && l.orderAdjustment !== 0)
				.reduce((s, l) => s + l.adjustment, 0),
		),
	};
}

// Each Shippo label katasync bought for orders placed in the range, with its
// box as declared and what was re-billed on it. A label for several orders
// is one label.
export async function postageBoxes(db: Db, start: Date, end: Date) {
	const rebilled = db
		.select({
			shipmentId: shipmentAdjustments.shipmentId,
			amount: sql<number>`sum(${shipmentAdjustments.amount})::float8`.as(
				"amount",
			),
		})
		.from(shipmentAdjustments)
		.groupBy(shipmentAdjustments.shipmentId)
		.as("rebilled");
	return db
		.selectDistinctOn([shipments.id], {
			shipmentId: shipments.id,
			orderId: orders.id,
			orderName: orders.name,
			storeChannel: stores.channel,
			marketplaceOrderId: orders.marketplaceOrderId,
			placedAt: orders.placedAt,
			packageId: shipments.packageId,
			packageName: packages.name,
			lengthMm: shipments.lengthMm,
			widthMm: shipments.widthMm,
			heightMm: shipments.heightMm,
			weightGrams: shipments.weightGrams,
			serviceName: shipments.serviceName,
			cost: shipments.cost,
			rebilled: sql<number>`coalesce(${rebilled.amount}, 0)`,
		})
		.from(shipments)
		.innerJoin(
			dispatches,
			and(
				eq(dispatches.id, shipments.dispatchId),
				sql`${dispatches.boughtAt} is not null`,
			),
		)
		.innerJoin(dispatchOrders, liveLabel)
		.innerJoin(
			orders,
			and(eq(orders.id, dispatchOrders.orderId), isNull(orders.cancelledAt)),
		)
		.innerJoin(stores, eq(stores.id, orders.storeId))
		.leftJoin(packages, eq(packages.id, shipments.packageId))
		.leftJoin(rebilled, eq(rebilled.shipmentId, shipments.id))
		.where(and(gte(orders.placedAt, start), lt(orders.placedAt, end)))
		.orderBy(shipments.id, orders.id);
}

export type PostageBox = Awaited<ReturnType<typeof postageBoxes>>[number];

export type BoxGroup = {
	// Saved box, or the size typed in for that label alone.
	key: string;
	packageId: number | null;
	name: string | null;
	box: [number, number, number];
	labels: number;
	rebilled: (RebilledOrder & { weightGrams: number; serviceName: string })[];
	amount: number;
	cost: number;
};

// Labels by box, worst re-billed first, only boxes with a re-bill.
export function groupBoxes(boxes: PostageBox[]): BoxGroup[] {
	const groups = new Map<string, BoxGroup>();
	for (const b of boxes) {
		const box: [number, number, number] = [b.lengthMm, b.widthMm, b.heightMm];
		const key =
			b.packageId === null ? `size:${box.join("x")}` : `box:${b.packageId}`;
		const g = groups.get(key) ?? {
			key,
			packageId: b.packageId,
			name: b.packageName,
			box,
			labels: 0,
			rebilled: [],
			amount: 0,
			cost: 0,
		};
		g.labels++;
		if (b.rebilled !== 0) {
			g.rebilled.push({
				id: b.orderId,
				name: b.orderName,
				// Where it really sold: a relayed order is its marketplace's.
				soldOn: (b.marketplaceOrderId?.split(":")[0] ??
					b.storeChannel) as PostageLine["soldOn"],
				marketplaceId: null,
				placedAt: b.placedAt,
				amount: b.rebilled,
				labels: b.cost,
				weightGrams: b.weightGrams,
				serviceName: b.serviceName,
			});
			g.amount = cents(g.amount + b.rebilled);
			g.cost = cents(g.cost + b.cost);
		}
		groups.set(key, g);
	}
	return [...groups.values()]
		.filter((g) => g.rebilled.length > 0)
		.sort(
			(a, b) => b.amount - a.amount || b.rebilled.length - a.rebilled.length,
		);
}

export type LabelRebill = {
	shipmentId: number;
	reason: RebillReason;
	// The whole label's, even when other orders share it.
	amount: number;
	postedAt: Date;
	// Other orders on the same label, who share the amount.
	sharedWith: number;
};

// Why Shippo re-billed the labels these orders shipped on, each item as it
// billed it, by order.
export async function labelRebills(db: Db, orderIds: number[]) {
	const byOrder = new Map<number, LabelRebill[]>();
	if (orderIds.length === 0) return byOrder;
	const rows = await db
		.select({
			orderId: dispatchOrders.orderId,
			shipmentId: shipmentAdjustments.shipmentId,
			description: shipmentAdjustments.description,
			amount: shipmentAdjustments.amount,
			postedAt: shipmentAdjustments.postedAt,
			sharedWith: sql<number>`(select count(*)::int - 1 from ${dispatchOrders} d
				join ${orders} o on o.id = d.order_id and o.cancelled_at is null
				where d.dispatch_id = ${shipments.dispatchId})`,
		})
		.from(shipmentAdjustments)
		.innerJoin(shipments, eq(shipments.id, shipmentAdjustments.shipmentId))
		.innerJoin(dispatchOrders, liveLabel)
		.where(inArray(dispatchOrders.orderId, orderIds))
		.orderBy(shipmentAdjustments.postedAt, shipmentAdjustments.id);
	for (const { orderId, description, ...r } of rows) {
		const list = byOrder.get(orderId) ?? [];
		list.push({ ...r, reason: rebillReason(description) });
		byOrder.set(orderId, list);
	}
	return byOrder;
}
