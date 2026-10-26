import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	productBulkPrices,
	productSuppliers,
	products,
	purchaseOrderDamages,
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrderReceipts,
	supplierOffers,
} from "#/db/schema";
import { postReceipt, undoBatch } from "#/inventory/ledger";
import { postArrival } from "#/inventory/valuation";
import type { DiscountOff } from "#/purchasing/discount";
import { discountRow, receiptUnitCost } from "#/purchasing/discount";
import { perPack } from "#/purchasing/pack";
import { closeIfComplete, reopen, shortLines } from "./closing";
import { checkDiscounts, checkOff } from "./discount-checks";
import { insertLine } from "./lines";
import { lockOrder, lockOrders, PurchaseOrderError, poName } from "./lock";
import { landedTerms, receiptWorth, revaluePurchaseOrder } from "./revalue";

// What arrived for one line, in the line's unit: 2 cases of 30 puts 60 on the
// shelf at the PO's location, and its landed cost into the product's average.
// Closes the PO once every line has arrived in full.
// More than expected means the supplier sent extra and we're keeping it, so
// the line now expects what arrived. `last` says nothing more is coming, so
// the line expects only what arrived. Either change is saved on the receipt,
// so undoing it puts the line back. Neither reaches the supplier.
// `discount` is one that came with this delivery, e.g. 1 free in the box, on
// some of what arrived (all of it when units is left out). The supplier's
// price stays the price before discounts.
export async function receive(
	db: Db,
	input: {
		lineId: number;
		quantity: number;
		last?: boolean;
		discount?: { units?: number; off: DiscountOff };
	},
) {
	if (!Number.isInteger(input.quantity) || input.quantity <= 0)
		throw new PurchaseOrderError(
			`Quantity must be a positive whole number, got ${input.quantity}`,
		);
	const discountUnits = input.discount?.units ?? input.quantity;
	if (
		input.discount &&
		!(discountUnits >= 1 && discountUnits <= input.quantity)
	)
		throw new PurchaseOrderError(
			`The discount can cover 1 to ${input.quantity}, the number that came`,
		);
	if (input.discount) checkOff(input.discount.off);
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!found) throw new PurchaseOrderError("That line doesn't exist");
		const po = await lockOrder(tx, found.purchaseOrderId, ["sent"]);
		// Read once the PO is locked: whatever held the lock (a damage report
		// asking for replacements, say) may have changed what it expects.
		const [line] = await tx
			.select()
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!line) throw new PurchaseOrderError("That line doesn't exist");
		// Receipts of this product on other POs wait here, so each one averages
		// its price against stock and cost the last one left.
		await tx
			.select({ id: products.id })
			.from(products)
			.where(eq(products.id, line.productId))
			.for("update");

		const { batchId } = await postReceipt(tx, {
			productId: line.productId,
			locationId: po.locationId,
			quantity: input.quantity * line.packSize,
			reference: poName(po.id),
		});
		const total = (await receivedOf(tx, line.id)) + input.quantity;
		const expect =
			total > line.quantity || (input.last && total < line.quantity)
				? total
				: null;
		if (expect !== null)
			await tx
				.update(purchaseOrderLines)
				.set({ quantity: expect })
				.where(eq(purchaseOrderLines.id, line.id));
		const [receipt] = await tx
			.insert(purchaseOrderReceipts)
			.values({
				lineId: line.id,
				quantity: input.quantity,
				batchId,
				...(expect !== null
					? { quantityBefore: line.quantity, quantityAfter: expect }
					: {}),
			})
			.returning({ id: purchaseOrderReceipts.id });
		if (input.discount) {
			await tx.insert(purchaseOrderDiscounts).values({
				lineId: line.id,
				receiptId: receipt.id,
				...discountRow({ units: discountUnits, off: input.discount.off }),
			});
		}
		const discounts = await checkDiscounts(tx, line.id);

		// What came is worth the line's price after discounts plus its share of
		// the PO's charges. With no price yet it comes in at the average, and
		// setting the price later puts the difference in (revalue.ts).
		const quantity = expect ?? line.quantity;
		const items = input.quantity * line.packSize;
		const { split } = await landedTerms(tx, po.id);
		await postArrival(tx, {
			productId: line.productId,
			units: items,
			value:
				line.unitCost === null
					? null
					: input.quantity *
							receiptUnitCost({
								line: { quantity, unitCost: line.unitCost },
								discounts,
								receipt: { id: receipt.id, quantity: input.quantity },
							}) +
						items * (split.perItem.get(line.id) ?? 0),
			batchId,
			purchaseOrderLineId: line.id,
			note: poName(po.id),
		});
		if (
			line.unitCost !== null &&
			!(await keepBulkPrice(tx, {
				productId: line.productId,
				supplierId: po.supplierId,
				packSize: line.packSize,
				quantity,
				unitCost: line.unitCost,
			}))
		)
			await keepSupplierPrice(tx, {
				productId: line.productId,
				supplierId: po.supplierId,
				price: line.unitCost / line.packSize,
			});
		await revaluePurchaseOrder(tx, po.id);
		const closed = await closeIfComplete(tx, po.id);
		return { receiptId: receipt.id, closed };
	});
}

// Everything still expected on a sent PO came: each line short of what it
// expects receives the rest, in one go. Back-ordered lines are left, since
// the supplier said those aren't in this delivery; receive them on their own
// if they came. What's left is worked out under the lock, so a line someone
// else just received isn't received twice. Undo with undoReceipts.
export async function receiveAll(db: Db, purchaseOrderId: number) {
	return db.transaction(async (tx) => {
		await lockOrder(tx, purchaseOrderId, ["sent"]);
		const lines = await tx
			.select({
				id: purchaseOrderLines.id,
				quantity: purchaseOrderLines.quantity,
			})
			.from(purchaseOrderLines)
			.where(
				and(
					eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
					isNull(purchaseOrderLines.backOrderedAt),
				),
			)
			.orderBy(asc(purchaseOrderLines.id));
		const receipts: { lineId: number; receiptId: number; quantity: number }[] =
			[];
		let closed = false;
		for (const line of lines) {
			const remaining = line.quantity - (await receivedOf(tx, line.id));
			if (remaining <= 0) continue;
			const r = await receive(tx, { lineId: line.id, quantity: remaining });
			receipts.push({
				lineId: line.id,
				receiptId: r.receiptId,
				quantity: remaining,
			});
			closed = r.closed;
		}
		if (receipts.length === 0)
			throw new PurchaseOrderError(
				`Nothing left to receive on ${poName(purchaseOrderId)}`,
			);
		return { receipts, closed };
	});
}

// Undoes several receipts together, as Receive all made them: all of them or,
// if one can't be, none.
export async function undoReceipts(db: Db, receiptIds: number[]) {
	return db.transaction(async (tx) => {
		if (receiptIds.length === 0) return;
		const owners = await tx
			.selectDistinct({ id: purchaseOrderLines.purchaseOrderId })
			.from(purchaseOrderReceipts)
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
			)
			.where(inArray(purchaseOrderReceipts.id, receiptIds));
		await lockOrders(
			tx,
			owners.map((owner) => owner.id),
			["sent", "closed"],
		);
		for (const id of [...receiptIds].reverse()) await undoReceipt(tx, id);
	});
}

// Takes a receipt back off the shelf, e.g. a mis-tap, and the value it
// brought in back out of the average. Reopens the PO if that leaves
// something short.
export async function undoReceipt(db: Db, receiptId: number) {
	return db.transaction(async (tx) => {
		const [receipt] = await tx
			.select({
				id: purchaseOrderReceipts.id,
				lineId: purchaseOrderReceipts.lineId,
				quantity: purchaseOrderReceipts.quantity,
				batchId: purchaseOrderReceipts.batchId,
				undoesId: purchaseOrderReceipts.undoesId,
				quantityBefore: purchaseOrderReceipts.quantityBefore,
				quantityAfter: purchaseOrderReceipts.quantityAfter,
				purchaseOrderId: purchaseOrderLines.purchaseOrderId,
				productId: purchaseOrderLines.productId,
			})
			.from(purchaseOrderReceipts)
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
			)
			.where(eq(purchaseOrderReceipts.id, receiptId));
		if (!receipt || receipt.undoesId !== null)
			throw new PurchaseOrderError("Nothing to undo");
		const po = await lockOrder(tx, receipt.purchaseOrderId, ["sent", "closed"]);
		const [already] = await tx
			.select({ id: purchaseOrderReceipts.id })
			.from(purchaseOrderReceipts)
			.where(eq(purchaseOrderReceipts.undoesId, receipt.id));
		if (already) throw new PurchaseOrderError("Already undone");
		// What the line expects now, read under the lock; the quantity read
		// above may be stale.
		const [line] = await tx
			.select({
				packSize: purchaseOrderLines.packSize,
				quantity: purchaseOrderLines.quantity,
			})
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, receipt.lineId));
		const left = (await receivedOf(tx, receipt.lineId)) - receipt.quantity;
		const damaged = await damagedOf(tx, receipt.lineId);
		if (left * line.packSize < damaged)
			throw new PurchaseOrderError(
				`${damaged} of these are recorded as damaged; take the damage back first`,
			);

		// Out at what it's worth now, price fixes and charges since included,
		// so nothing it brought in stays behind.
		const worth = await receiptWorth(tx, po.id, receipt.id);
		const { batchId } = await undoBatch(tx, receipt.batchId, {
			costs:
				worth === null
					? undefined
					: [
							{
								productId: receipt.productId,
								kind: "undo",
								units: -receipt.quantity * line.packSize,
								value: -worth,
								purchaseOrderLineId: receipt.lineId,
								note: "Undo: receipt",
							},
						],
		});
		await tx.insert(purchaseOrderReceipts).values({
			lineId: receipt.lineId,
			quantity: -receipt.quantity,
			batchId,
			undoesId: receipt.id,
		});
		// A discount that came with it goes too. It was never on the PO as sent.
		await tx
			.delete(purchaseOrderDiscounts)
			.where(eq(purchaseOrderDiscounts.receiptId, receipt.id));
		// Only when nobody has changed the quantity since.
		if (
			receipt.quantityBefore !== null &&
			line.quantity === receipt.quantityAfter
		)
			await tx
				.update(purchaseOrderLines)
				.set({ quantity: receipt.quantityBefore })
				.where(eq(purchaseOrderLines.id, receipt.lineId));
		await checkDiscounts(tx, receipt.lineId);
		if (po.status === "closed" && (await shortLines(tx, po.id)) > 0)
			await reopen(tx, po.id);
		await revaluePurchaseOrder(tx, po.id);
	});
}

// Something arrived that isn't on the PO, or more of something that is:
// it's added if needed and received in one go, so it can't be left half
// done. Expecting nothing before the receipt, undoing it leaves the line
// expecting nothing. Works on a closed PO too, since the box may hold more
// after everything else is in.
export async function receiveExtra(
	db: Db,
	input: {
		purchaseOrderId: number;
		productId: number;
		quantity: number;
		discount?: { units?: number; off: DiscountOff };
	},
) {
	return db.transaction(async (tx) => {
		const po = await lockOrder(
			tx,
			input.purchaseOrderId,
			["sent", "closed"],
			[input.productId],
		);
		const { line } = await insertLine(tx, po, {
			productId: input.productId,
			quantity: 0,
		});
		if (po.status === "closed") await reopen(tx, po.id);
		const result = await receive(tx, {
			lineId: line.id,
			quantity: input.quantity,
			discount: input.discount,
		});
		return { ...result, lineId: line.id };
	});
}

// Puts a note on a line for whoever receives it, or takes it off with null.
// Only on a PO on order: that's when someone is unpacking it. Blank counts as
// none. Returns the note it replaced, for undo.
export async function setReceivingNote(
	db: Db,
	input: { lineId: number; note: string | null },
) {
	const note = input.note?.trim() || null;
	return db.transaction(async (tx) => {
		const [line] = await tx
			.select({
				purchaseOrderId: purchaseOrderLines.purchaseOrderId,
				note: purchaseOrderLines.receivingNote,
			})
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!line) throw new PurchaseOrderError("That line doesn't exist");
		await lockOrder(tx, line.purchaseOrderId, ["sent", "closed"]);
		await tx
			.update(purchaseOrderLines)
			.set({ receivingNote: note })
			.where(eq(purchaseOrderLines.id, input.lineId));
		return { was: line.note, note };
	});
}

// Marks a line back-ordered, or not. Only on a PO on order, and only while
// some of the line hasn't come: that's what's back-ordered. Marking one
// already marked keeps the day it was first marked. Returns whether it was,
// for undo.
export async function setBackOrdered(
	db: Db,
	input: { lineId: number; backOrdered: boolean },
) {
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!found) throw new PurchaseOrderError("That line doesn't exist");
		await lockOrder(tx, found.purchaseOrderId, ["sent"]);
		const [line] = await tx
			.select({
				quantity: purchaseOrderLines.quantity,
				backOrderedAt: purchaseOrderLines.backOrderedAt,
			})
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (
			input.backOrdered &&
			(await receivedOf(tx, input.lineId)) >= line.quantity
		)
			throw new PurchaseOrderError(
				"All of it has come, so none of it is back-ordered",
			);
		if (input.backOrdered !== (line.backOrderedAt !== null))
			await tx
				.update(purchaseOrderLines)
				.set({ backOrderedAt: input.backOrdered ? sql`now()` : null })
				.where(eq(purchaseOrderLines.id, input.lineId));
		return { was: line.backOrderedAt !== null };
	});
}

export async function receivedOf(tx: Db, lineId: number) {
	const [row] = await tx
		.select({
			units: sql<number>`coalesce(sum(${purchaseOrderReceipts.quantity}), 0)::int`,
		})
		.from(purchaseOrderReceipts)
		.where(eq(purchaseOrderReceipts.lineId, lineId));
	return row.units;
}

// Single items of a line recorded as damaged. Never more than arrived, so a
// receipt can't be undone from under them (see undoReceipt).
export async function damagedOf(tx: Db, lineId: number) {
	const [row] = await tx
		.select({
			items: sql<number>`coalesce(sum(${purchaseOrderDamages.quantity}), 0)::int`,
		})
		.from(purchaseOrderDamages)
		.where(eq(purchaseOrderDamages.lineId, lineId));
	return row.items;
}

// A line big enough for one of the supplier's bulk prices paid that bulk
// price: the last price paid goes there instead, so the price for smaller
// orders stays. Counted in single items, so a line in an old pack size
// still finds the bulk price it reached, and its price converts to the bulk
// price's pack. Returns whether one took it.
async function keepBulkPrice(
	tx: Db,
	p: {
		productId: number;
		supplierId: number;
		packSize: number;
		quantity: number;
		unitCost: number;
	},
) {
	const offer = and(
		eq(productBulkPrices.productId, p.productId),
		eq(productBulkPrices.supplierId, p.supplierId),
	);
	const [reached] = await tx
		.select({
			minQuantity: productBulkPrices.minQuantity,
			packSize: productBulkPrices.packSize,
		})
		.from(productBulkPrices)
		.where(
			and(
				offer,
				lte(
					sql`${productBulkPrices.minQuantity} * ${productBulkPrices.packSize}`,
					p.quantity * p.packSize,
				),
			),
		)
		.orderBy(desc(productBulkPrices.minQuantity))
		.limit(1);
	if (!reached) return false;
	await tx
		.update(productBulkPrices)
		.set({ cost: perPack(p.unitCost, p.packSize, reached.packSize) })
		.where(and(offer, eq(productBulkPrices.minQuantity, reached.minQuantity)));
	return true;
}

// The supplier's price becomes the last price paid before discounts, so a
// one-off discount doesn't carry over, in whatever unit the product is bought
// in now. It only changes while the supplier still sells the product (carries
// its catalog), so terms don't pile up where reorder never looks.
async function keepSupplierPrice(
	db: Db,
	p: { productId: number; supplierId: number; price: number },
) {
	// One statement, so the pack size it multiplies by is the row's current one
	// even if a new default is being saved at the same time. Same rounding as
	// perPack. A supplier with no terms of its own yet sells in EACH.
	await db.execute(sql`
		insert into ${productSuppliers} (product_id, supplier_id, supplier_count, cost)
		select ${supplierOffers.productId}, ${supplierOffers.supplierId}, 1,
			round(${p.price}::numeric, 4)
		from ${supplierOffers}
		where ${supplierOffers.productId} = ${p.productId}
			and ${supplierOffers.supplierId} = ${p.supplierId}
		on conflict (product_id, supplier_id) do update
			set cost = round(${p.price}::numeric * ${productSuppliers.packSize}, 4)`);
}

// The PO a ledger batch belongs to, when it's a receipt or a receipt's undo.
// Those must be undone on the PO, so its receipts and status stay right.
export async function purchaseOrderOfBatch(
	db: Db,
	batchId: string,
): Promise<number | null> {
	const [row] = await db
		.select({ id: purchaseOrderLines.purchaseOrderId })
		.from(purchaseOrderReceipts)
		.innerJoin(
			purchaseOrderLines,
			eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
		)
		.where(eq(purchaseOrderReceipts.batchId, batchId));
	return row?.id ?? null;
}
