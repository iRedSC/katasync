import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderDiscounts,
	purchaseOrderLines,
	purchaseOrders,
	suppliers,
} from "#/db/schema";
import { lockOrder, PurchaseOrderError, poName } from "./lock";
import { splitSets } from "./set-parts";

// Puts a draft on order. sentTo is where it went, or null when it was ordered
// some other way (phone, their website). `deliver`, when given, sends it and
// returns the address it went to. It runs inside the transaction with the PO
// locked and gets that transaction, so what it sends is exactly what's saved
// as sent; if it fails, the PO stays a draft.
export async function markSent(
	db: Db,
	input: {
		purchaseOrderId: number;
		sentTo?: string | null;
		now?: Date;
		deliver?: (tx: Db) => Promise<string>;
	},
): Promise<string | null> {
	const now = input.now ?? new Date();
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, input.purchaseOrderId, [
			"draft",
			"suggested",
		]);
		await splitSets(tx, po.id);
		const lines = await tx
			.select({ id: purchaseOrderLines.id })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
		if (lines.length === 0)
			throw new PurchaseOrderError(`${poName(po.id)} has nothing on it`);
		// Saved before the PDF is built, so it prints exactly these.
		await tx
			.update(purchaseOrderLines)
			.set({
				sentQuantity: purchaseOrderLines.quantity,
				sentUnitCost: purchaseOrderLines.unitCost,
			})
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
		await tx
			.update(purchaseOrderDiscounts)
			.set({ sent: true })
			.where(
				inArray(
					purchaseOrderDiscounts.lineId,
					tx
						.select({ id: purchaseOrderLines.id })
						.from(purchaseOrderLines)
						.where(eq(purchaseOrderLines.purchaseOrderId, po.id)),
				),
			);
		const [supplier] = await tx
			.select({ leadTimeDays: suppliers.leadTimeDays })
			.from(suppliers)
			.where(eq(suppliers.id, po.supplierId));
		const sentTo = input.deliver
			? await input.deliver(tx)
			: (input.sentTo ?? null);
		await tx
			.update(purchaseOrders)
			.set({
				status: "sent",
				sentAt: now,
				sentTo,
				expectedAt: new Date(
					now.getTime() + supplier.leadTimeDays * 86_400_000,
				),
			})
			.where(eq(purchaseOrders.id, po.id));
		return sentTo;
	});
}
