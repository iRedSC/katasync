import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { locations, purchaseOrderLines, purchaseOrders } from "#/db/schema";
import { lockForEdit, PurchaseOrderError } from "./lock";

// The supplier's draft, created empty if it doesn't exist. Delivered to the
// first of our own locations; it can be changed before sending. A suggested
// PO is only a look at the suggestion, so it becomes this empty draft.
export async function openDraft(db: Db, supplierId: number): Promise<number> {
	return db.transaction(async (tx) => {
		const [existing] = await currentDraft(tx, supplierId);
		if (existing?.status === "suggested") {
			await tx
				.delete(purchaseOrderLines)
				.where(eq(purchaseOrderLines.purchaseOrderId, existing.id));
			await tx
				.update(purchaseOrders)
				.set({ status: "draft" })
				.where(eq(purchaseOrders.id, existing.id));
		}
		if (existing) return existing.id;
		const [po] = await tx
			.insert(purchaseOrders)
			.values({ supplierId, locationId: await firstLocation(tx) })
			.onConflictDoNothing()
			.returning({ id: purchaseOrders.id });
		if (po) return po.id;
		// Someone else created it a moment ago.
		return openDraft(tx, supplierId);
	});
}

// The supplier's draft or suggested PO, locked. There's at most one.
export function currentDraft(tx: Db, supplierId: number) {
	return tx
		.select({ id: purchaseOrders.id, status: purchaseOrders.status })
		.from(purchaseOrders)
		.where(
			and(
				eq(purchaseOrders.supplierId, supplierId),
				inArray(purchaseOrders.status, ["draft", "suggested"]),
			),
		)
		.for("update");
}

// Where a new PO is delivered: the first of our own locations.
export async function firstLocation(tx: Db) {
	const [location] = await tx
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"))
		.orderBy(locations.id)
		.limit(1);
	if (!location)
		throw new PurchaseOrderError("Add a location to deliver POs to first");
	return location.id;
}

export async function updateDraft(
	db: Db,
	input: {
		purchaseOrderId: number;
		notes?: string | null;
		locationId?: number;
	},
) {
	return db.transaction(async (tx) => {
		await lockForEdit(tx, input.purchaseOrderId);
		if (input.locationId !== undefined) {
			const [location] = await tx
				.select({ kind: locations.kind })
				.from(locations)
				.where(eq(locations.id, input.locationId));
			if (location?.kind !== "owned" && location?.kind !== "retail")
				throw new PurchaseOrderError("POs can only go to our own locations");
		}
		await tx
			.update(purchaseOrders)
			.set({
				...(input.notes !== undefined
					? { notes: input.notes?.trim() || null }
					: {}),
				...(input.locationId !== undefined
					? { locationId: input.locationId }
					: {}),
			})
			.where(eq(purchaseOrders.id, input.purchaseOrderId));
	});
}
