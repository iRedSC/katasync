import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	products,
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { discountOf } from "#/purchasing/discount";
import { renderPurchaseOrder } from "#/purchasing/document";
import { poAddress } from "#/purchasing/inbox/graph";
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

// Units still short on back-ordered lines, summed over the lines joined to
// `received`. Counted in the product itself, as `ordered` is.
export function backOrderedUnits(received: ReturnType<typeof receivedByLine>) {
	return sql<number>`coalesce(sum(greatest(${purchaseOrderLines.quantity} - coalesce(${received.units}, 0), 0) * ${purchaseOrderLines.packSize}) filter (where ${purchaseOrderLines.backOrderedAt} is not null), 0)::int`;
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
			supplierSku: supplierOffers.supplierSku,
			unit: purchaseOrderLines.unit,
			packSize: purchaseOrderLines.packSize,
			supplierCount: purchaseOrderLines.supplierCount,
			minimumQuantity: purchaseOrderLines.minimumQuantity,
			// The PO's supplier while it still sells the product (carries its
			// catalog), else null. A line's terms can become that supplier's
			// default only then.
			linkSupplierId: supplierOffers.supplierId,
			defaultUnit: supplierOffers.unit,
			defaultPackSize: supplierOffers.packSize,
			defaultSupplierCount: supplierOffers.supplierCount,
			defaultMinimum: supplierOffers.minimumQuantity,
			quantity: purchaseOrderLines.quantity,
			unitCost: purchaseOrderLines.unitCost,
			// What the supplier was sent; null on drafts and on lines added
			// after sending.
			sentQuantity: purchaseOrderLines.sentQuantity,
			sentUnitCost: purchaseOrderLines.sentUnitCost,
			locked: purchaseOrderLines.locked,
			receivingNote: purchaseOrderLines.receivingNote,
			backOrderedAt: purchaseOrderLines.backOrderedAt,
			addedAt: purchaseOrderLines.addedAt,
			received: sql<number>`coalesce(${received.units}, 0)::int`,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.leftJoin(
			supplierOffers,
			and(
				eq(supplierOffers.productId, products.id),
				eq(supplierOffers.supplierId, po.order.supplierId),
			),
		)
		.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
		.where(eq(purchaseOrderLines.purchaseOrderId, poId))
		// In the order they were added, so a new line lands last.
		.orderBy(purchaseOrderLines.addedAt, purchaseOrderLines.id);
	const discounts = (
		lines.length === 0
			? []
			: await db
					.select({
						id: purchaseOrderDiscounts.id,
						lineId: purchaseOrderDiscounts.lineId,
						units: purchaseOrderDiscounts.units,
						percent: purchaseOrderDiscounts.percent,
						amount: purchaseOrderDiscounts.amount,
						receiptId: purchaseOrderDiscounts.receiptId,
						sent: purchaseOrderDiscounts.sent,
						removedAt: purchaseOrderDiscounts.removedAt,
						createdAt: purchaseOrderDiscounts.createdAt,
					})
					.from(purchaseOrderDiscounts)
					.where(
						inArray(
							purchaseOrderDiscounts.lineId,
							lines.map((l) => l.id),
						),
					)
					.orderBy(purchaseOrderDiscounts.id)
	).map(discountOf);
	return {
		...po,
		lines: lines.map((l) => {
			const mine = discounts.filter((d) => d.lineId === l.id);
			return {
				...l,
				// In force now, oldest first.
				discounts: mine
					.filter((d) => d.removedAt === null)
					.map(({ id, units, off, receiptId }) => ({
						id,
						units,
						off,
						receiptId,
					})),
				// What the supplier was sent, even if taken off since.
				sentDiscounts: mine
					.filter((d) => d.sent)
					.map(({ units, off }) => ({ units, off })),
			};
		}),
		// Every discount, taken off or not, for the PO's timeline.
		discountHistory: discounts,
	};
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
				? {
						quantity: l.sentQuantity,
						unitCost: l.sentUnitCost,
						discounts: l.sentDiscounts,
					}
				: sentAt === null
					? {
							quantity: l.quantity,
							unitCost: l.unitCost,
							discounts: l.discounts.map(({ units, off }) => ({ units, off })),
						}
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
				// The PO's own inbox address, so mail to it lands on this PO.
				email:
					poAddress(poId) ?? process.env.PO_EMAIL_REPLY_TO ?? po.location.email,
			},
			supplier: po.supplier,
			notes,
			lines: printedLines(po.lines, po.order.sentAt),
		}),
	};
}

// Every supplier with how many products it sells (in the catalogs it
// carries) and its POs on order.
export function supplierRows(db: Db) {
	return db
		.select({
			supplier: suppliers,
			// Written out in full: in a one-table select Drizzle leaves column
			// names unqualified, so a subquery's supplier_id would compare
			// against its own table's id instead of the supplier's.
			products: sql<number>`(select count(*) from supplier_offers so where so.supplier_id = "suppliers"."id")::int`,
			openOrders: sql<number>`(select count(*) from purchase_orders po where po.supplier_id = "suppliers"."id" and po.status = 'sent')::int`,
		})
		.from(suppliers)
		.orderBy(suppliers.name);
}
