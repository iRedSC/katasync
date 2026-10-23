import { asc, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseOrderCharges } from "#/db/schema";
import type { ChargeKind } from "#/purchasing/landed";
import { lockOrder, PurchaseOrderError } from "./lock";
import { revaluePurchaseOrder } from "./revalue";

// Freight, duty, fees and credits on a PO, spread over its lines into what
// each item cost (src/purchasing/landed.ts). Stock already in is revalued at
// once, so a bill that comes after the delivery still lands in the cost.

// Whole cents, more than 0. A credit is given as what it takes off.
function checkAmount(amount: number) {
	if (!(Number.isFinite(amount) && amount > 0))
		throw new PurchaseOrderError(`An amount is more than $0, got ${amount}`);
	if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6)
		throw new PurchaseOrderError(`An amount is in whole cents, got ${amount}`);
}

export async function addCharge(
	db: Db,
	input: { purchaseOrderId: number; kind: ChargeKind; amount: number },
) {
	checkAmount(input.amount);
	return db.transaction(async (tx) => {
		await lockOrder(tx, input.purchaseOrderId, ["draft", "sent", "closed"]);
		const [row] = await tx
			.insert(purchaseOrderCharges)
			.values({
				purchaseOrderId: input.purchaseOrderId,
				kind: input.kind,
				amount: input.kind === "credit" ? -input.amount : input.amount,
			})
			.returning();
		await revaluePurchaseOrder(tx, input.purchaseOrderId);
		return row;
	});
}

// Takes a charge off. Returns it, for undo.
export async function removeCharge(db: Db, id: number) {
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select()
			.from(purchaseOrderCharges)
			.where(eq(purchaseOrderCharges.id, id));
		if (!found) throw new PurchaseOrderError("That charge is already off");
		await lockOrder(tx, found.purchaseOrderId, ["draft", "sent", "closed"]);
		await tx
			.delete(purchaseOrderCharges)
			.where(eq(purchaseOrderCharges.id, id));
		await revaluePurchaseOrder(tx, found.purchaseOrderId);
		return {
			purchaseOrderId: found.purchaseOrderId,
			kind: found.kind,
			amount: Math.abs(found.amount),
		};
	});
}

export function chargesOf(db: Db, purchaseOrderId: number) {
	return db
		.select()
		.from(purchaseOrderCharges)
		.where(eq(purchaseOrderCharges.purchaseOrderId, purchaseOrderId))
		.orderBy(asc(purchaseOrderCharges.id));
}
