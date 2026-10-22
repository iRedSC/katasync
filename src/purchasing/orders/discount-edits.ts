import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrderReceipts,
} from "#/db/schema";
import type { Discount } from "#/purchasing/discount";
import { discountOf, discountRow, receiptLeft } from "#/purchasing/discount";
import { checkDiscounts, checkOff, lineDiscounts } from "./discount-checks";
import { lockForEdit, PurchaseOrderError, poName } from "./lock";
import { receivedOf } from "./receiving";

// When a draft line's pack size changes: discounts on a number of units
// cover the same items in the new unit, so 6 EACH become 1 CASE of 6. One
// that doesn't come to whole units is refused, rather than rounded. Then
// checked against the line's new quantity and price.
export async function convertDiscounts(
	tx: Db,
	line: { id: number; packSize: number },
	packSize: number,
) {
	for (const d of await lineDiscounts(tx, [line.id])) {
		if (d.units === "rest") continue;
		const items = d.units * line.packSize;
		if (items % packSize !== 0)
			throw new PurchaseOrderError(
				`A discount covers ${items} of it, which isn't a whole number of packs of ${packSize}; change it first`,
			);
		await tx
			.update(purchaseOrderDiscounts)
			.set({ units: items / packSize })
			.where(eq(purchaseOrderDiscounts.id, d.id));
	}
	await checkDiscounts(tx, line.id);
}

// The PO a line is on, locked for a change to it: a draft (a suggested PO
// becomes one), or one already sent, which tells no one.
async function lockLineOrder(tx: Db, lineId: number) {
	const [found] = await tx
		.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
		.from(purchaseOrderLines)
		.where(eq(purchaseOrderLines.id, lineId));
	if (!found) throw new PurchaseOrderError("That line doesn't exist");
	return lockForEdit(tx, found.purchaseOrderId, ["draft", "sent", "closed"]);
}

// Puts a discount on a line. On a PO already sent the supplier isn't told,
// and the PDF stays as sent. `replaces` takes one of the line's discounts off
// in the same change, which is how one is edited. `receiptId` puts back one
// that came with a delivery, so undoing that receipt still takes it off.
// Stock that already arrived keeps the cost it came in at (receivedAtOldCost).
export async function saveDiscount(
	db: Db,
	input: {
		lineId: number;
		discount: Discount;
		replaces?: number;
		receiptId?: number;
	},
) {
	const { discount } = input;
	if (
		discount.units !== "rest" &&
		!(Number.isInteger(discount.units) && discount.units > 0)
	)
		throw new PurchaseOrderError(
			`A discount covers a whole number of units, got ${discount.units}`,
		);
	checkOff(discount.off);
	return db.transaction(async (tx) => {
		await lockLineOrder(tx, input.lineId);
		const replaced =
			input.replaces === undefined
				? null
				: await takeOffDiscount(tx, input.replaces, input.lineId);
		if (input.receiptId !== undefined)
			await checkReceiptDiscount(tx, input.receiptId, input.lineId, discount);
		await checkDiscounts(tx, input.lineId, discount);
		const [row] = await tx
			.insert(purchaseOrderDiscounts)
			.values({
				lineId: input.lineId,
				receiptId: input.receiptId,
				...discountRow(discount),
			})
			.returning({ id: purchaseOrderDiscounts.id });
		return {
			id: row.id,
			replaced,
			receivedAtOldCost: (await receivedOf(tx, input.lineId)) > 0,
		};
	});
}

// A discount that came with a receipt covers some of what that receipt
// brought, which is still in (not undone), on the same line. Together with the
// others on that receipt, it can't cover more than came.
async function checkReceiptDiscount(
	tx: Db,
	receiptId: number,
	lineId: number,
	discount: Discount,
) {
	const [receipt] = await tx
		.select({
			lineId: purchaseOrderReceipts.lineId,
			quantity: purchaseOrderReceipts.quantity,
		})
		.from(purchaseOrderReceipts)
		.where(eq(purchaseOrderReceipts.id, receiptId));
	const [undone] = await tx
		.select({ id: purchaseOrderReceipts.id })
		.from(purchaseOrderReceipts)
		.where(eq(purchaseOrderReceipts.undoesId, receiptId));
	if (!receipt || receipt.lineId !== lineId || receipt.quantity <= 0 || undone)
		throw new PurchaseOrderError("That delivery isn't on this line any more");
	// Replacements are already off by now, so they don't count against it.
	const onReceipt = (await lineDiscounts(tx, [lineId])).filter(
		(d) => d.receiptId === receiptId,
	);
	const left = receiptLeft(receipt.quantity, onReceipt);
	if (left <= 0)
		throw new PurchaseOrderError(
			`The ${receipt.quantity} that came are all discounted already`,
		);
	if (discount.units === "rest" || discount.units > left)
		throw new PurchaseOrderError(
			`The discount can cover 1 to ${left}, of the ${receipt.quantity} that came and aren't discounted yet`,
		);
}

// Takes a discount off its line. Returns it as it was, for undo. With
// purchaseOrderId, refuses one on another PO.
export async function removeDiscount(
	db: Db,
	id: number,
	purchaseOrderId?: number,
) {
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select({ lineId: purchaseOrderDiscounts.lineId })
			.from(purchaseOrderDiscounts)
			.where(eq(purchaseOrderDiscounts.id, id));
		if (!found) throw new PurchaseOrderError("That discount is already off");
		const po = await lockLineOrder(tx, found.lineId);
		if (purchaseOrderId !== undefined && po.id !== purchaseOrderId)
			throw new PurchaseOrderError(
				`That discount is on ${poName(po.id)}, not ${poName(purchaseOrderId)}`,
			);
		const removed = await takeOffDiscount(tx, id, found.lineId);
		await checkDiscounts(tx, found.lineId);
		return {
			...removed,
			receivedAtOldCost: (await receivedOf(tx, found.lineId)) > 0,
		};
	});
}

// One printed on the PO as sent is only marked removed, so it still prints.
async function takeOffDiscount(tx: Db, id: number, lineId: number) {
	const [row] = await tx
		.select()
		.from(purchaseOrderDiscounts)
		.where(
			and(
				eq(purchaseOrderDiscounts.id, id),
				eq(purchaseOrderDiscounts.lineId, lineId),
				isNull(purchaseOrderDiscounts.removedAt),
			),
		)
		.for("update");
	if (!row) throw new PurchaseOrderError("That discount is already off");
	if (row.sent)
		await tx
			.update(purchaseOrderDiscounts)
			.set({ removedAt: new Date() })
			.where(eq(purchaseOrderDiscounts.id, id));
	else
		await tx
			.delete(purchaseOrderDiscounts)
			.where(eq(purchaseOrderDiscounts.id, id));
	const { units, off } = discountOf(row);
	return { lineId, units, off, receiptId: row.receiptId };
}
