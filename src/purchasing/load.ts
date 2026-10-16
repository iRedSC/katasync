import { eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	suppliers,
} from "#/db/schema";
import { renderPurchaseOrder } from "#/purchasing/document";
import { PurchaseOrderError, poName } from "#/purchasing/orders";

// Reading a PO and building its PDF. Server only: the PDF renderer can't run
// in the browser, so client code must not import this file directly.

// Units received per line, net of undos.
export function receivedByLine(db: Db) {
	return db
		.select({
			lineId: purchaseOrderReceipts.lineId,
			units: sql<number>`sum(${purchaseOrderReceipts.quantity})::int`.as(
				"units",
			),
		})
		.from(purchaseOrderReceipts)
		.groupBy(purchaseOrderReceipts.lineId)
		.as("received");
}

export async function loadOrder(db: Db, poId: number) {
	const [po] = await db
		.select({
			order: purchaseOrders,
			supplier: suppliers,
			location: locations,
		})
		.from(purchaseOrders)
		.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
		.innerJoin(locations, eq(locations.id, purchaseOrders.locationId))
		.where(eq(purchaseOrders.id, poId));
	if (!po) throw new PurchaseOrderError(`${poName(poId)} doesn't exist`);

	const received = receivedByLine(db);
	const lines = await db
		.select({
			id: purchaseOrderLines.id,
			productId: products.id,
			sku: products.sku,
			// A tool set only appears on drafts; sending splits it into parts.
			kind: products.kind,
			name: products.name,
			variantName: products.variantName,
			imageUrl: products.imageUrl,
			barcode: products.barcode,
			supplierSku: productSuppliers.supplierSku,
			unit: purchaseOrderLines.unit,
			packSize: purchaseOrderLines.packSize,
			supplierCount: purchaseOrderLines.supplierCount,
			minimumQuantity: purchaseOrderLines.minimumQuantity,
			// Who the product is bought from now. A line's terms can become the
			// product's default only on that supplier's PO.
			linkSupplierId: productSuppliers.supplierId,
			defaultUnit: productSuppliers.unit,
			defaultPackSize: productSuppliers.packSize,
			defaultSupplierCount: productSuppliers.supplierCount,
			defaultMinimum: productSuppliers.minimumQuantity,
			quantity: purchaseOrderLines.quantity,
			unitCost: purchaseOrderLines.unitCost,
			// What the supplier was sent; null on drafts and on lines added
			// after sending.
			sentQuantity: purchaseOrderLines.sentQuantity,
			sentUnitCost: purchaseOrderLines.sentUnitCost,
			locked: purchaseOrderLines.locked,
			received: sql<number>`coalesce(${received.units}, 0)::int`,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
		.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
		.where(eq(purchaseOrderLines.purchaseOrderId, poId))
		.orderBy(products.name, products.variantName);
	return { ...po, lines };
}

// What the PO prints: always what the supplier was sent. Changes made after
// sending are ours alone, so they never print; a draft prints as it stands.
export function printedLines(
	lines: Awaited<ReturnType<typeof loadOrder>>["lines"],
	sentAt: Date | null,
) {
	return lines.flatMap((l) => {
		const printed =
			l.sentQuantity !== null
				? { quantity: l.sentQuantity, unitCost: l.sentUnitCost }
				: sentAt === null
					? { quantity: l.quantity, unitCost: l.unitCost }
					: null;
		if (!printed) return [];
		return [
			{
				sku: l.sku,
				supplierSku: l.supplierSku,
				description: l.variantName ? `${l.name} (${l.variantName})` : l.name,
				unit: l.unit,
				supplierCount: l.supplierCount,
				...printed,
			},
		];
	});
}

export async function documentFor(db: Db, poId: number) {
	const po = await loadOrder(db, poId);
	const notes = [po.supplier.poNotes, po.order.notes].filter((n): n is string =>
		Boolean(n),
	);
	return {
		po,
		filename: `${poName(poId).replace(" ", "-")}.pdf`,
		pdf: await renderPurchaseOrder({
			id: poId,
			date: po.order.sentAt ?? new Date(),
			buyer: {
				name: po.location.shipFromName ?? po.location.name,
				address1: po.location.address1,
				address2: po.location.address2,
				city: po.location.city,
				region: po.location.region,
				postalCode: po.location.postalCode,
				country: po.location.country,
				phone: po.location.phone,
				email: process.env.PO_EMAIL_REPLY_TO ?? po.location.email,
			},
			supplier: po.supplier,
			notes,
			lines: printedLines(po.lines, po.order.sentAt),
		}),
	};
}

// Every supplier with how many products it supplies and its POs on order.
export function supplierRows(db: Db) {
	return db
		.select({
			supplier: suppliers,
			// Written out in full: in a one-table select Drizzle leaves column
			// names unqualified, so a subquery's supplier_id would compare
			// against its own table's id instead of the supplier's.
			products: sql<number>`(select count(*) from product_suppliers ps where ps.supplier_id = "suppliers"."id")::int`,
			openOrders: sql<number>`(select count(*) from purchase_orders po where po.supplier_id = "suppliers"."id" and po.status = 'sent')::int`,
		})
		.from(suppliers)
		.orderBy(suppliers.name);
}
