import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, products, purchaseOrderLines } from "#/db/schema";
import { isOurs } from "#/inventory/locations";
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

// productBySku for many SKUs at once, in the order given. Any one missing
// fails the lot, naming the first one that isn't there.
export async function productsBySku(db: Db, skus: string[]) {
	if (skus.length === 0) return [];
	const found = await db
		.select({ id: products.id, sku: products.sku, kind: products.kind })
		.from(products)
		.where(
			inArray(
				products.sku,
				skus.map((s) => s.trim()),
			),
		);
	const bySku = new Map(found.map((p) => [p.sku, p]));
	return skus.map((sku) => {
		const product = bySku.get(sku.trim());
		if (!product) throw new PurchaseOrderError(`No product with SKU ${sku}`);
		return product;
	});
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
