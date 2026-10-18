import { eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
} from "#/db/schema";
import { lockOrder, PurchaseOrderError, poName } from "./lock";

// Calls off a sent PO. Once anything has arrived, close it instead. Drafts
// are deleted (deleteDraft), not cancelled.
export async function cancelOrder(db: Db, id: number, now = new Date()) {
	return db.transaction(async (tx) => {
		await lockOrder(tx, id, ["sent"]);
		const [{ received }] = await tx
			.select({
				received: sql<number>`coalesce(sum(${purchaseOrderReceipts.quantity}), 0)::int`,
			})
			.from(purchaseOrderReceipts)
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
			)
			.where(eq(purchaseOrderLines.purchaseOrderId, id));
		if (received > 0)
			throw new PurchaseOrderError(
				`Part of ${poName(id)} has arrived; close it instead`,
			);
		await tx
			.update(purchaseOrders)
			.set({ status: "cancelled", closedAt: now })
			.where(eq(purchaseOrders.id, id));
	});
}

// Undoes cancelOrder: back on order. Cancelling changes nothing else, so
// that's all there is to put back.
export async function restoreOrder(db: Db, id: number) {
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, id, ["cancelled"]);
		// Drafts used to be cancelled rather than deleted; those stay as they are.
		if (!po.sentAt)
			throw new PurchaseOrderError(`${poName(id)} was never sent`);
		await tx
			.update(purchaseOrders)
			.set({ status: "sent", closedAt: null })
			.where(eq(purchaseOrders.id, id));
	});
}
