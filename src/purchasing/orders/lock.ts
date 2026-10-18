import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseOrders } from "#/db/schema";
import type { Status } from "./types";

export class PurchaseOrderError extends Error {
	name = "PurchaseOrderError";
}

export const poName = (id: number) => `PO ${id}`;

// Every change to a PO starts here, so two people receiving the same box
// can't both count it.
export async function lockOrder(db: Db, id: number, allowed: Status[]) {
	const [po] = await db
		.select()
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, id))
		.for("update");
	if (!po) throw new PurchaseOrderError(`${poName(id)} doesn't exist`);
	if (!allowed.includes(po.status))
		throw new PurchaseOrderError(`${poName(id)} is ${po.status}`);
	return po;
}

// Locks a PO for a change to what it orders or where it goes. A suggested PO
// becomes a draft with its first change, and stops following the suggestion.
export async function lockForEdit(
	db: Db,
	id: number,
	allowed: Status[] = ["draft"],
) {
	const po = await lockOrder(
		db,
		id,
		allowed.includes("draft") ? [...allowed, "suggested"] : allowed,
	);
	if (po.status !== "suggested") return po;
	await db
		.update(purchaseOrders)
		.set({ status: "draft" })
		.where(eq(purchaseOrders.id, id));
	return { ...po, status: "draft" as const };
}
