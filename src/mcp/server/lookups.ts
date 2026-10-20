import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, products, purchaseOrderLines } from "#/db/schema";
import { isOurs } from "#/inventory/locations";
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

// One of our locations (warehouse or retail store) by name. Without a name,
// the only one, since guessing between several would put stock on the wrong
// shelf.
export async function ourLocation(db: Db, name?: string) {
	const ours = await db
		.select({ id: locations.id, name: locations.name })
		.from(locations)
		.where(isOurs)
		.orderBy(locations.name);
	if (name) {
		const found = ours.find((l) => l.name === name);
		if (!found)
			throw new PurchaseOrderError(
				`No location of ours called ${name}; there's ${ours.map((l) => l.name).join(", ")}`,
			);
		return found.id;
	}
	if (ours.length !== 1)
		throw new PurchaseOrderError(
			ours.length === 0
				? "There's no location of ours yet"
				: `Name a location: ${ours.map((l) => l.name).join(", ")}`,
		);
	return ours[0].id;
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
