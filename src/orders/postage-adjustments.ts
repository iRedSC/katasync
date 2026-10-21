import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	orderCharges,
	orderLineProfit,
	orderLines,
	orders,
	products,
} from "#/db/schema";
import { contentsKey } from "#/shipping/contents";

// What carriers re-billed on labels for a size or weight other than declared
// (postage_adjustment charges), grouped so the cause can be fixed: by what was
// in the box, and by product.
//
// Only Amazon reports re-bills so far, and its labels are bought on Seller
// Central, so katasync has no box for them: Amazon names the order, not the
// package, and says neither why nor what the carrier measured. What was in
// the box is the closest thing to the box. Each re-billed order links to
// Seller Central, whose order page shows the package as it was declared.

const lp = orderLineProfit;

// Orders in the range from marketplaces that re-bill (those with a re-bill on
// record), shipped with a label they billed, one row per item.
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
				eq(orderCharges.kind, "label"),
				inArray(orderCharges.billedBy, rebillers),
			),
		);
	return db
		.select({
			orderId: lp.orderId,
			orderName: orders.name,
			soldOn: lp.soldOn,
			marketplaceOrderId: orders.marketplaceOrderId,
			placedAt: lp.placedAt,
			// The order's whole re-bill, and this item's share of it and of the
			// label, shared by sales as order_line_profit shares them.
			orderAdjustment: sql<number>`(
				select coalesce(sum(${orderCharges.amount}), 0)::float8
				from ${orderCharges}
				where ${orderCharges.orderId} = ${lp.orderId}
					and ${orderCharges.kind} = 'postage_adjustment'
			)`,
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
				inArray(lp.orderId, labelled),
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
