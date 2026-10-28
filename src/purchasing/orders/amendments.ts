import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderAmendments,
	purchaseOrderLines,
	purchaseOrderReceipts,
} from "#/db/schema";
import { settle } from "./closing";
import { checkDiscounts } from "./discount-checks";
import { lockOrder, PurchaseOrderError } from "./lock";
import { checkPrice } from "./price";
import { receivedOf } from "./receiving";
import { revaluePurchaseOrder } from "./revalue";

// Changes a sent line without telling the supplier: we're keeping what they
// got wrong. The PDF still shows what was sent. A quantity can't go under
// what's already arrived; 0 means none are coming. A line added after
// sending that never received anything is taken off instead of kept at 0.
// Stock that already came in is revalued to the new price. Returns what the
// line was, for undo.
export async function amendLine(
	db: Db,
	input: { lineId: number; quantity?: number; unitCost?: number | null },
) {
	if (
		input.quantity !== undefined &&
		!(Number.isInteger(input.quantity) && input.quantity >= 0)
	)
		throw new PurchaseOrderError(
			`Quantity must be a whole number, got ${input.quantity}`,
		);
	checkPrice(input.unitCost);
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!found) throw new PurchaseOrderError("That line doesn't exist");
		const po = await lockOrder(tx, found.purchaseOrderId, ["sent", "closed"]);
		const [line] = await tx
			.select()
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		const received = await receivedOf(tx, line.id);
		const was = { quantity: line.quantity, unitCost: line.unitCost };
		const quantity = input.quantity ?? line.quantity;
		if (quantity < received)
			throw new PurchaseOrderError(
				`${received} already arrived; undo a receipt to go lower`,
			);
		const removed =
			quantity === 0 &&
			line.sentQuantity === null &&
			!(await hasReceipt(tx, line.id));
		if (removed) {
			await tx
				.delete(purchaseOrderLines)
				.where(eq(purchaseOrderLines.id, line.id));
			await tx.insert(purchaseOrderAmendments).values({
				purchaseOrderId: po.id,
				productId: line.productId,
				kind: "removed",
				quantityBefore: line.quantity,
			});
			await settle(tx, po, null);
		} else {
			await tx
				.update(purchaseOrderLines)
				.set({
					quantity,
					...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
				})
				.where(eq(purchaseOrderLines.id, line.id));
			await checkDiscounts(tx, line.id);
			// Each change goes on the PO's timeline.
			const base = { purchaseOrderId: po.id, productId: line.productId };
			if (quantity !== line.quantity) {
				await tx.insert(purchaseOrderAmendments).values({
					...base,
					kind: "quantity",
					quantityBefore: line.quantity,
					quantityAfter: quantity,
				});
				await settle(tx, po, quantity > received);
			}
			if (input.unitCost !== undefined && input.unitCost !== line.unitCost)
				await tx.insert(purchaseOrderAmendments).values({
					...base,
					kind: "cost",
					unitCostBefore: line.unitCost,
					unitCostAfter: input.unitCost,
				});
		}
		// Either way the PO's charges spread over different lines now.
		await revaluePurchaseOrder(tx, po.id);
		return { was, removed };
	});
}

async function hasReceipt(tx: Db, lineId: number) {
	const [receipt] = await tx
		.select({ id: purchaseOrderReceipts.id })
		.from(purchaseOrderReceipts)
		.where(eq(purchaseOrderReceipts.lineId, lineId))
		.limit(1);
	return receipt !== undefined;
}
