import { and, eq } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import { locations, products, purchaseOrderLines } from "#/db/schema";
import { loadOrder } from "#/purchasing/load";
import { PurchaseOrderError } from "#/purchasing/orders";

export async function lineOf(db: Db, po: number, sku: string) {
	const product = await productBySku(db, sku);
	const [line] = await db
		.select({ id: purchaseOrderLines.id })
		.from(purchaseOrderLines)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, po),
				eq(purchaseOrderLines.productId, product.id),
			),
		);
	if (!line) throw new PurchaseOrderError(`${product.sku} isn't on PO ${po}`);
	return line.id;
}

export async function productBySku(db: Db, sku: string) {
	const [product] = await db
		.select({ id: products.id, sku: products.sku, kind: products.kind })
		.from(products)
		.where(eq(products.sku, sku.trim()));
	if (!product) throw new PurchaseOrderError(`No product with SKU ${sku}`);
	return product;
}

export async function ownedLocation(db: Db, name?: string) {
	if (name) {
		const [found] = await db
			.select({ id: locations.id, kind: locations.kind })
			.from(locations)
			.where(eq(locations.name, name));
		if (found?.kind !== "owned")
			throw new PurchaseOrderError(`No location of ours called ${name}`);
		return found.id;
	}
	const only = await shippingLocation(db);
	if (only === null)
		throw new PurchaseOrderError("There are several locations; name one");
	return only;
}

// When a PO marked sent outside katasync went out: midday that day, so it's
// the same day in any US timezone. Not in the future, and not before the PO
// existed.
export async function sentDay(db: Db, po: number, day: string) {
	const at = new Date(`${day}T12:00:00Z`);
	if (Number.isNaN(at.getTime()) || day > new Date().toISOString().slice(0, 10))
		throw new PurchaseOrderError(`${day} isn't a day that has passed`);
	const { order } = await loadOrder(db, po);
	const made = order.createdAt.toISOString().slice(0, 10);
	if (day < made)
		throw new PurchaseOrderError(`PO ${po} was made on ${made}, after ${day}`);
	// Today's midday may not have come yet.
	return at > new Date() ? new Date() : at;
}
