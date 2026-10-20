import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	locations,
	productSuppliers,
	products,
	purchaseOrderDamages,
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrderReceipts,
	stockLevels,
} from "#/db/schema";
import { postReceipt, undoBatch } from "#/inventory/ledger";
import { isOurs } from "#/inventory/locations";
import type { DiscountOff } from "#/purchasing/discount";
import { discountRow, receiptUnitCost } from "#/purchasing/discount";
import { closeIfComplete, reopen, shortLines } from "./closing";
import { checkDiscounts, checkOff } from "./discount-checks";
import { insertLine } from "./lines";
import { lockOrder, PurchaseOrderError, poName } from "./lock";

// What arrived for one line, in the line's unit: 2 cases of 30 puts 60 on the
// shelf at the PO's location. Folds its price into the product's average cost.
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

		const before = await ownedOnHand(tx, line.productId);
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

		if (line.unitCost !== null) {
			const quantity = expect ?? line.quantity;
			await averageInCost(tx, {
				productId: line.productId,
				onHandBefore: before,
				quantity: input.quantity * line.packSize,
				unitCost:
					receiptUnitCost({
						line: { quantity, unitCost: line.unitCost },
						discounts,
						receipt: { id: receipt.id, quantity: input.quantity },
					}) / line.packSize,
				price: line.unitCost / line.packSize,
			});
		}
		const closed = await closeIfComplete(tx, po.id);
		return { receiptId: receipt.id, closed };
	});
}

// Takes a receipt back off the shelf, e.g. a mis-tap. Reopens the PO if that
// leaves something short. The average cost isn't unwound: later receipts
// correct it, and reconstructing it exactly isn't worth the bookkeeping.
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

		const { batchId } = await undoBatch(tx, receipt.batchId);
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
		const po = await lockOrder(tx, input.purchaseOrderId, ["sent", "closed"]);
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

async function ownedOnHand(db: Db, productId: number) {
	const owned = db.select({ id: locations.id }).from(locations).where(isOurs);
	const [row] = await db
		.select({
			onHand: sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`,
		})
		.from(stockLevels)
		.where(
			and(
				eq(stockLevels.productId, productId),
				inArray(stockLevels.locationId, owned),
			),
		);
	return row.onHand;
}

// Weighted average of what's on the shelf and what just arrived, per one of
// the product. Oversold units (negative stock) have no cost to average in, so
// they count as none. The supplier's price becomes the last price paid
// before discounts, in whatever unit the product is bought in now.
export function averageCost(p: {
	oldCost: number | null;
	onHandBefore: number;
	quantity: number;
	unitCost: number;
}) {
	const held = Math.max(0, p.onHandBefore);
	if (p.oldCost === null || held === 0) return p.unitCost;
	return (held * p.oldCost + p.quantity * p.unitCost) / (held + p.quantity);
}

// unitCost is what each one cost after discounts; price is before them, and
// becomes the supplier's price, so a one-off discount doesn't carry over.
async function averageInCost(
	db: Db,
	p: {
		productId: number;
		onHandBefore: number;
		quantity: number;
		unitCost: number;
		price: number;
	},
) {
	const [product] = await db
		.select({ unitCost: products.unitCost })
		.from(products)
		.where(eq(products.id, p.productId));
	const cost = averageCost({ ...p, oldCost: product.unitCost });
	await db
		.update(products)
		.set({ unitCost: Math.round(cost * 10_000) / 10_000 })
		.where(eq(products.id, p.productId));
	// One statement, so the pack size it multiplies by is the row's current one
	// even if a new default is being saved at the same time. Same rounding as
	// perPack.
	await db
		.update(productSuppliers)
		.set({
			cost: sql`round(${p.price}::numeric * ${productSuppliers.packSize}, 4)`,
		})
		.where(eq(productSuppliers.productId, p.productId));
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
