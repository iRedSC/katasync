import { eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
} from "#/db/schema";
import { lockOrder } from "./lock";
import { revaluePurchaseOrder } from "./revalue";

// After a line's quantity changes: a sent PO with everything in closes, and
// a closed one reopens when the changed line is now waiting on more. `short`
// is whether it is, or null when the line was taken off.
export async function settle(
	tx: Db,
	po: typeof purchaseOrders.$inferSelect,
	short: boolean | null,
) {
	if (po.status === "sent") await closeIfComplete(tx, po.id);
	else if (po.status === "closed" && short) await reopen(tx, po.id);
}

export async function reopen(tx: Db, id: number) {
	await tx
		.update(purchaseOrders)
		.set({ status: "sent", closedAt: null })
		.where(eq(purchaseOrders.id, id));
}

// Stops waiting for what hasn't arrived, e.g. the supplier is out of it. Its
// charges then fall on what did come.
export async function closeOrder(db: Db, id: number, now = new Date()) {
	return db.transaction(async (tx) => {
		await lockOrder(tx, id, ["sent"]);
		await tx
			.update(purchaseOrders)
			.set({ status: "closed", closedAt: now })
			.where(eq(purchaseOrders.id, id));
		await revaluePurchaseOrder(tx, id);
	});
}

export async function closeIfComplete(db: Db, id: number) {
	if ((await shortLines(db, id)) > 0) return false;
	await db
		.update(purchaseOrders)
		.set({ status: "closed", closedAt: new Date() })
		.where(eq(purchaseOrders.id, id));
	return true;
}

// Lines that haven't fully arrived.
export async function shortLines(db: Db, id: number) {
	const received = db
		.select({
			lineId: purchaseOrderReceipts.lineId,
			units: sql<number>`sum(${purchaseOrderReceipts.quantity})`.as("units"),
		})
		.from(purchaseOrderReceipts)
		.groupBy(purchaseOrderReceipts.lineId)
		.as("received");
	const [{ short }] = await db
		.select({
			short: sql<number>`count(*) filter (where ${purchaseOrderLines.quantity} > coalesce(${received.units}, 0))::int`,
		})
		.from(purchaseOrderLines)
		.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
		.where(eq(purchaseOrderLines.purchaseOrderId, id));
	return short;
}
