import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "#/db/client";
import {
	locations,
	productComponents,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderMovedParts,
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
			minimumQuantity: purchaseOrderLines.minimumQuantity,
			// Who the product is bought from now. A line's terms can become the
			// product's default only on that supplier's PO.
			linkSupplierId: productSuppliers.supplierId,
			defaultUnit: productSuppliers.unit,
			defaultPackSize: productSuppliers.packSize,
			defaultMinimum: productSuppliers.minimumQuantity,
			quantity: purchaseOrderLines.quantity,
			unitCost: purchaseOrderLines.unitCost,
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

// The parts of a draft's tool set lines, for showing under each set: how many
// single items it needs, who the part is bought from, whether it was moved to
// that supplier's draft, and the unit it will land in when sent (its line on
// this PO, else the supplier's unit), which may round it up.
export async function setPartsOf(db: Db, poId: number) {
	const part = alias(products, "part");
	const partLine = alias(purchaseOrderLines, "part_line");
	return db
		.select({
			lineId: purchaseOrderLines.id,
			productId: part.id,
			sku: part.sku,
			name: part.name,
			variantName: part.variantName,
			items: sql<number>`(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize} * ${productComponents.quantity})::int`,
			supplierId: productSuppliers.supplierId,
			supplierName: suppliers.name,
			moved: sql<boolean>`${purchaseOrderMovedParts.purchaseOrderId} is not null`,
			unit: sql<string>`coalesce(${partLine.unit}, ${productSuppliers.unit}, 'EACH')`,
			packSize: sql<number>`coalesce(${partLine.packSize}, ${productSuppliers.packSize}, 1)::int`,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.innerJoin(
			productComponents,
			eq(productComponents.parentProductId, purchaseOrderLines.productId),
		)
		.innerJoin(part, eq(part.id, productComponents.componentProductId))
		.leftJoin(productSuppliers, eq(productSuppliers.productId, part.id))
		.leftJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
		.leftJoin(
			purchaseOrderMovedParts,
			and(
				eq(purchaseOrderMovedParts.purchaseOrderId, poId),
				eq(purchaseOrderMovedParts.setProductId, purchaseOrderLines.productId),
				eq(purchaseOrderMovedParts.partProductId, part.id),
			),
		)
		.leftJoin(
			partLine,
			and(eq(partLine.purchaseOrderId, poId), eq(partLine.productId, part.id)),
		)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, poId),
				eq(products.kind, "bundle"),
			),
		)
		.orderBy(part.name, part.variantName);
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
			lines: po.lines.map((l) => ({
				sku: l.sku,
				supplierSku: l.supplierSku,
				description: l.variantName ? `${l.name} (${l.variantName})` : l.name,
				unit: l.unit,
				packSize: l.packSize,
				quantity: l.quantity,
				unitCost: l.unitCost,
			})),
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
