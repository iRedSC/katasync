import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import {
	locations,
	products,
	purchaseOrderAmendments,
	purchaseOrderDamages,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	suppliers,
} from "#/db/schema";
import { isOurs } from "#/inventory/locations";
import { stockRanges } from "#/inventory/stock-range";
import { damagesOf } from "#/purchasing/damage";
import { emailConfigured } from "#/purchasing/email";
import { poFilesOf } from "#/purchasing/files";
import { leadTimes } from "#/purchasing/forecast";
import { emailsOf } from "#/purchasing/inbox/ingest";
import { invoicesOf } from "#/purchasing/invoices";
import { loadOrder, receivedByLine } from "#/purchasing/load";
import {
	draftChanges,
	PurchaseOrderError,
	partsOfSets,
	poName,
	refreshSuggested,
	setPartsOf,
} from "#/purchasing/orders";
import {
	recommendedAdditions,
	reorderBreakdown,
	suggestPurchases,
} from "#/purchasing/reorder";
import { trackingOf } from "#/purchasing/tracking";
import { listUnits } from "#/purchasing/units";
import { id } from "./id-input";
import { onHandOf } from "./on-hand";
import { leadTimeOf } from "./suppliers";

// The receipts on a PO that can still be undone, newest first. All of them,
// not a count for the whole PO: each line's undo steps back through its own
// receipts, so a cap would cut off undos that are still open.
function undoableReceipts(db: Db, poId: number) {
	return db
		.select({
			id: purchaseOrderReceipts.id,
			lineId: purchaseOrderReceipts.lineId,
			quantity: purchaseOrderReceipts.quantity,
			// Set when the receipt changed what the line expects.
			quantityBefore: purchaseOrderReceipts.quantityBefore,
			quantityAfter: purchaseOrderReceipts.quantityAfter,
			createdAt: purchaseOrderReceipts.createdAt,
		})
		.from(purchaseOrderReceipts)
		.innerJoin(
			purchaseOrderLines,
			eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
		)
		.where(
			and(
				eq(purchaseOrderLines.purchaseOrderId, poId),
				isNull(purchaseOrderReceipts.undoesId),
				sql`not exists (select 1 from ${purchaseOrderReceipts} u where u.undoes_id = ${purchaseOrderReceipts.id})`,
			),
		)
		.orderBy(desc(purchaseOrderReceipts.id));
}

export const getPurchaseOrder = createServerFn({ method: "GET" })
	.validator(id)
	.handler(async ({ data }) => {
		const db = getDb();
		// A suggested PO shows today's suggestion, not the one it was opened with.
		await refreshSuggested(db, data.id);
		const po = await loadOrder(db, data.id);
		const unsent =
			po.order.status === "draft" || po.order.status === "suggested";
		const setParts = unsent ? await setPartsOf(db, data.id) : [];
		// A set's parts show their stock too.
		const productIds = [
			...new Set([
				...po.lines.map((l) => l.productId),
				...setParts.map((p) => p.productId),
			]),
		];
		const [
			onHand,
			ranges,
			receipts,
			ownedLocations,
			changes,
			units,
			lead,
			amendments,
			recommended,
			whys,
			invoices,
			damages,
			emails,
			tracking,
			files,
		] = await Promise.all([
			onHandOf(db, productIds),
			stockRanges(db, productIds),
			undoableReceipts(db, data.id),
			db
				.select({ id: locations.id, name: locations.name })
				.from(locations)
				.where(isOurs)
				.orderBy(locations.kind, locations.name),
			// On a draft: how today's suggestions differ from it (see draftChanges).
			// The page works out raised and skipped from each line's wants, so
			// they follow quantities and locks as they change. A suggested PO is
			// the suggestion.
			po.order.status === "draft"
				? Promise.all([suggestPurchases(db), partsOfSets(db, data.id)]).then(
						([all, fromSets]) => {
							const c = draftChanges(
								po.lines,
								all.find((s) => s.supplierId === po.supplier.id)?.lines ?? [],
								fromSets,
							);
							return { added: c.added.length, wants: c.wants };
						},
					)
				: { added: 0, wants: new Map<number, number>() },
			listUnits(db).then((all) => all.map((u) => u.name)),
			leadTimes(db, [po.supplier.id]),
			// Changes made after sending, for the timeline.
			db
				.select({
					id: purchaseOrderAmendments.id,
					kind: purchaseOrderAmendments.kind,
					quantityBefore: purchaseOrderAmendments.quantityBefore,
					quantityAfter: purchaseOrderAmendments.quantityAfter,
					unitCostBefore: purchaseOrderAmendments.unitCostBefore,
					unitCostAfter: purchaseOrderAmendments.unitCostAfter,
					createdAt: purchaseOrderAmendments.createdAt,
					name: products.name,
					variantName: products.variantName,
				})
				.from(purchaseOrderAmendments)
				.innerJoin(products, eq(products.id, purchaseOrderAmendments.productId))
				.where(eq(purchaseOrderAmendments.purchaseOrderId, data.id))
				.orderBy(desc(purchaseOrderAmendments.id))
				.limit(200),
			// On a draft: what else from this supplier is worth adding (see
			// recommendedAdditions), leaving out what's on it already, sets'
			// parts too.
			unsent
				? partsOfSets(db, data.id).then((fromSets) =>
						recommendedAdditions(
							db,
							po.supplier.id,
							new Set([...productIds, ...fromSets.keys()]),
						),
					)
				: [],
			// Why reorder wants what it does of each, for the velocity gauge.
			reorderBreakdown(db, { productIds }).then(
				(all) => new Map(all.map((b) => [b.line.productId, b.why])),
			),
			invoicesOf(db, data.id),
			damagesOf(db, data.id),
			emailsOf(db, data.id),
			trackingOf(db, data.id),
			poFilesOf(db, data.id),
		]);
		return {
			leadTime: leadTimeOf(lead, po.supplier.id),
			changes: { added: changes.added },
			...po,
			lines: po.lines.map((l) => ({
				...l,
				// Single items today's suggestion wants; null when it doesn't
				// have the product, or on anything but a draft.
				wants: changes.wants.get(l.productId) ?? null,
				onHand: onHand.get(l.productId) ?? 0,
				// Every line's product has one; ?? only satisfies the Map type.
				stockRange: ranges.get(l.productId) ?? null,
				// Null for tool sets: they're ordered as their parts.
				why: whys.get(l.productId) ?? null,
			})),
			setParts: setParts.map((p) => ({
				...p,
				onHand: onHand.get(p.productId) ?? 0,
				stockRange: ranges.get(p.productId) ?? null,
				why: whys.get(p.productId) ?? null,
			})),
			recommended,
			receipts,
			amendments,
			invoices,
			damages,
			emails,
			tracking,
			files,
			locations: ownedLocations,
			units,
			emailConfigured: emailConfigured(),
		};
	});

export type PurchaseOrderDetail = Awaited<ReturnType<typeof getPurchaseOrder>>;

// What the receive page reads of a PO: its lines, what can still be undone,
// and damage. Not the desktop page's planning, costs, or mail. Receiving
// reloads after each change, so a lighter read pays on every one.
export const getReceivePurchaseOrder = createServerFn({ method: "GET" })
	.validator(id)
	.handler(async ({ data }) => {
		const db = getDb();
		const [po] = await db
			.select({
				id: purchaseOrders.id,
				status: purchaseOrders.status,
				supplierName: suppliers.name,
			})
			.from(purchaseOrders)
			.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
			.where(eq(purchaseOrders.id, data.id));
		if (!po) throw new PurchaseOrderError(`${poName(data.id)} doesn't exist`);
		const received = receivedByLine(db);
		const [lines, receipts, damages] = await Promise.all([
			db
				.select({
					id: purchaseOrderLines.id,
					productId: products.id,
					sku: products.sku,
					name: products.name,
					variantName: products.variantName,
					imageUrl: products.imageUrl,
					unit: purchaseOrderLines.unit,
					packSize: purchaseOrderLines.packSize,
					supplierCount: purchaseOrderLines.supplierCount,
					quantity: purchaseOrderLines.quantity,
					sentQuantity: purchaseOrderLines.sentQuantity,
					receivingNote: purchaseOrderLines.receivingNote,
					backOrderedAt: purchaseOrderLines.backOrderedAt,
					received: sql<number>`coalesce(${received.units}, 0)::int`,
				})
				.from(purchaseOrderLines)
				.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
				.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
				.where(eq(purchaseOrderLines.purchaseOrderId, data.id))
				.orderBy(purchaseOrderLines.addedAt, purchaseOrderLines.id),
			undoableReceipts(db, data.id),
			db
				.select({
					lineId: purchaseOrderDamages.lineId,
					quantity: purchaseOrderDamages.quantity,
					kind: purchaseOrderDamages.kind,
				})
				.from(purchaseOrderDamages)
				.innerJoin(
					purchaseOrderLines,
					eq(purchaseOrderLines.id, purchaseOrderDamages.lineId),
				)
				.where(eq(purchaseOrderLines.purchaseOrderId, data.id)),
		]);
		return {
			order: { id: po.id, status: po.status },
			supplier: { name: po.supplierName },
			lines,
			receipts,
			damages,
		};
	});
