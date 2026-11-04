import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	dispatchLines,
	dispatchOrders,
	orderLines,
	products,
} from "#/db/schema";
import { groupBy } from "#/lib/group-by";
import { toPrint } from "./remaining";

// What a packing slip lists per order: one item per thing in the box, and
// the money as the order has it now.

export type SlipItem = {
	productId: number | null;
	sku: string | null;
	// The channel's title, which keys contents when there's no SKU.
	title: string;
	// The catalog's short name, else the channel's title.
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	weightGrams: number | null;
	// What goes in the box, or null for a line sold but left out of the
	// bought box (another shipment's).
	toPack: number | null;
	// What the order sold of this line, for the price columns; null when the
	// order no longer sells it (edited away since its label was bought).
	sold: { quantity: number; unitPrice: number } | null;
};

export type Slip = {
	items: SlipItem[];
	// Every line the order sells now, priced: the invoice's subtotal.
	subtotal: number;
};

// Each order's slip: every line the order sells now, priced, so the rows add
// up to the subtotal, and what of each goes in the box. An order with a
// label bought and not yet handed off packs that box exactly as it was
// bought (dispatch_lines): its titles, SKUs, products and counts, whatever
// the order's lines say since, so a reprint matches what's in the box; a
// line it sells that isn't in that box is marked so, and a boxed line it no
// longer sells stays, unpriced. Otherwise its lines at what's left to pack
// (toPrint).
export async function slipsOf(
	db: Db,
	orders: { id: number; needsPacking: boolean }[],
): Promise<Map<number, Slip>> {
	const ids = orders.map((o) => o.id);
	if (ids.length === 0) return new Map();
	const [current, frozen] = await Promise.all([
		db
			.select({
				orderId: orderLines.orderId,
				externalId: orderLines.externalId,
				productId: orderLines.productId,
				sku: sql<string | null>`coalesce(${products.sku}, ${orderLines.sku})`,
				title: orderLines.title,
				name: sql<string>`coalesce(${products.name}, ${orderLines.title})`,
				quantity: orderLines.quantity,
				shippedQuantity: orderLines.shippedQuantity,
				unitPrice: orderLines.unitPrice,
				// The size or option to pick, from the catalog: channel titles
				// don't always carry it.
				variantName: products.variantName,
				weightGrams: products.weightGrams,
				imageUrl: products.imageUrl,
			})
			.from(orderLines)
			.leftJoin(products, eq(products.id, orderLines.productId))
			.where(and(inArray(orderLines.orderId, ids), gt(orderLines.quantity, 0)))
			.orderBy(orderLines.id),
		db
			.select({
				orderId: dispatchLines.orderId,
				externalId: dispatchLines.lineExternalId,
				productId: dispatchLines.productId,
				title: dispatchLines.title,
				sku: sql<
					string | null
				>`coalesce(${products.sku}, ${dispatchLines.sku})`,
				name: sql<string>`coalesce(${products.name}, ${dispatchLines.title})`,
				quantity: dispatchLines.quantity,
				variantName: products.variantName,
				weightGrams: products.weightGrams,
				imageUrl: products.imageUrl,
			})
			.from(dispatchLines)
			.innerJoin(
				dispatchOrders,
				and(
					eq(dispatchOrders.dispatchId, dispatchLines.dispatchId),
					eq(dispatchOrders.orderId, dispatchLines.orderId),
				),
			)
			.leftJoin(products, eq(products.id, dispatchLines.productId))
			// Live and not yet handed off: at most one per order (drizzle/0182).
			.where(
				and(
					inArray(dispatchLines.orderId, ids),
					isNull(dispatchOrders.channelSentAt),
					isNull(dispatchOrders.reversedAt),
					sql`dispatch_is_live(${dispatchLines.dispatchId})`,
				),
			)
			.orderBy(dispatchLines.orderLineId, dispatchLines.lineExternalId),
	]);
	const currentBy = groupBy(current, (l) => l.orderId);
	const frozenBy = groupBy(frozen, (l) => l.orderId);
	return new Map(
		orders.map((o) => {
			const lines = currentBy.get(o.id) ?? [];
			const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
			const box = frozenBy.get(o.id);
			const items: SlipItem[] = box ? boxed(lines, box) : unboxed(lines, o);
			return [o.id, { items, subtotal }];
		}),
	);
}

type Current = {
	externalId: string;
	productId: number | null;
	sku: string | null;
	title: string;
	name: string;
	quantity: number;
	shippedQuantity: number | null;
	unitPrice: number;
	variantName: string | null;
	weightGrams: number | null;
	imageUrl: string | null;
};
type Frozen = Omit<Current, "shippedQuantity" | "unitPrice">;

const sold = (l: Current) => ({ quantity: l.quantity, unitPrice: l.unitPrice });

// The bought box against the order as it is now: each line it sells, at the
// box's count of it (its frozen item, else null: not in this box), then what's in the box that it
// no longer sells.
function boxed(lines: Current[], box: Frozen[]): SlipItem[] {
	const left = [...box];
	const take = (externalId: string) => {
		const i = left.findIndex((f) => f.externalId === externalId);
		return i < 0 ? null : left.splice(i, 1)[0];
	};
	const priced = lines.map((line): SlipItem => {
		const frozen = take(line.externalId);
		return {
			...pick(frozen ?? line),
			toPack: frozen ? frozen.quantity : null,
			sold: sold(line),
		};
	});
	const gone = left.map(({ quantity, ...item }) => ({
		...pick(item),
		toPack: quantity,
		sold: null,
	}));
	return [...priced, ...gone];
}

function unboxed(lines: Current[], order: { needsPacking: boolean }) {
	return toPrint(lines, order).map(
		(l): SlipItem => ({ ...pick(l), toPack: l.toPack, sold: sold(l) }),
	);
}

const pick = (l: Omit<Frozen, "quantity">) => ({
	productId: l.productId,
	sku: l.sku,
	title: l.title,
	name: l.name,
	variantName: l.variantName,
	imageUrl: l.imageUrl,
	weightGrams: l.weightGrams,
});
