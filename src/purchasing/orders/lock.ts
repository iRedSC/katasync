import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseOrderLines, purchaseOrders } from "#/db/schema";
import { lockStockProducts } from "#/inventory/ledger/post";
import type { Status } from "./types";

export class PurchaseOrderError extends Error {
	name = "PurchaseOrderError";
}

export const poName = (id: number) => `PO ${id}`;

// Every change to a PO starts here, so two people receiving the same box
// can't both count it.
export async function lockOrder(
	db: Db,
	id: number,
	allowed: Status[],
	additionalProductIds: number[] = [],
) {
	const [po] = await lockOrders(db, [id], allowed, additionalProductIds);
	return po;
}

export async function lockOrders(
	db: Db,
	orderIds: number[],
	allowed: Status[],
	additionalProductIds: number[] = [],
) {
	const ids = [...new Set(orderIds)].sort((left, right) => left - right);
	const rows = ids.length
		? await db
				.select()
				.from(purchaseOrders)
				.where(inArray(purchaseOrders.id, ids))
				.orderBy(purchaseOrders.id)
				.for("update")
		: [];
	for (const id of ids) {
		const po = rows.find((row) => row.id === id);
		if (!po) throw new PurchaseOrderError(`${poName(id)} doesn't exist`);
		if (!allowed.includes(po.status))
			throw new PurchaseOrderError(`${poName(id)} is ${po.status}`);
	}
	const valued = rows.filter(
		(po) => po.status === "sent" || po.status === "closed",
	);
	const lines = valued.length
		? await db
				.select({ productId: purchaseOrderLines.productId })
				.from(purchaseOrderLines)
				.where(
					inArray(
						purchaseOrderLines.purchaseOrderId,
						valued.map((po) => po.id),
					),
				)
		: [];
	await lockStockProducts(db, [
		...lines.map((line) => line.productId),
		...additionalProductIds,
	]);
	return rows;
}

// Locks a PO for a change to what it orders or where it goes. A suggested PO
// becomes a draft with its first change, and stops following the suggestion.
export async function lockForEdit(
	db: Db,
	id: number,
	allowed: Status[] = ["draft"],
	additionalProductIds: number[] = [],
) {
	const po = await lockOrder(
		db,
		id,
		allowed.includes("draft") ? [...allowed, "suggested"] : allowed,
		additionalProductIds,
	);
	if (po.status !== "suggested") return po;
	await db
		.update(purchaseOrders)
		.set({ status: "draft" })
		.where(eq(purchaseOrders.id, id));
	return { ...po, status: "draft" as const };
}
