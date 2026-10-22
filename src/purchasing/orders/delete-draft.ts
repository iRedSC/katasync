import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	poFileUploads,
	purchaseOrderAmendments,
	purchaseOrderDiscounts,
	purchaseOrderFiles,
	purchaseOrderLines,
	purchaseOrderSkippedParts,
	purchaseOrders,
} from "#/db/schema";
import { discountRow } from "#/purchasing/discount";
import { checkDiscounts, lineDiscounts } from "./discount-checks";
import { currentDraft } from "./drafts";
import { lockOrder, PurchaseOrderError, poName } from "./lock";
import type { DeletedDraft } from "./types";

// Throws a draft away, lines and all. Nothing was sent, so there's no record
// worth keeping. Checked under the lock, so a PO sent a moment ago stays.
// Returns what was thrown away, for restoreDraft to put back.
export async function deleteDraft(db: Db, id: number): Promise<DeletedDraft> {
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, id, ["draft"]);
		const rows = await tx
			.select({
				id: purchaseOrderLines.id,
				productId: purchaseOrderLines.productId,
				unit: purchaseOrderLines.unit,
				packSize: purchaseOrderLines.packSize,
				supplierCount: purchaseOrderLines.supplierCount,
				minimumQuantity: purchaseOrderLines.minimumQuantity,
				quantity: purchaseOrderLines.quantity,
				unitCost: purchaseOrderLines.unitCost,
			})
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, id))
			.orderBy(purchaseOrderLines.id);
		const discounts = await lineDiscounts(
			tx,
			rows.map((l) => l.id),
		);
		const lines = rows.map(({ id: lineId, ...l }) => ({
			...l,
			discounts: discounts
				.filter((d) => d.lineId === lineId)
				.map(({ units, off }) => ({ units, off })),
		}));
		const skippedParts = await tx
			.select({
				setProductId: purchaseOrderSkippedParts.setProductId,
				partProductId: purchaseOrderSkippedParts.partProductId,
			})
			.from(purchaseOrderSkippedParts)
			.where(eq(purchaseOrderSkippedParts.purchaseOrderId, id));
		await dropFiles(tx, id);
		await tx
			.delete(purchaseOrderAmendments)
			.where(eq(purchaseOrderAmendments.purchaseOrderId, id));
		await tx
			.delete(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, id));
		await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, id));
		return {
			id,
			supplierId: po.supplierId,
			locationId: po.locationId,
			notes: po.notes,
			createdAt: po.createdAt,
			lines,
			skippedParts,
		};
	});
}

// A draft is only thrown away once its files are off it (Undo couldn't
// bring them back); ones already removed, and its upload links, go with it.
async function dropFiles(tx: Db, id: number) {
	const [live] = await tx
		.select({ id: purchaseOrderFiles.id })
		.from(purchaseOrderFiles)
		.where(
			and(
				eq(purchaseOrderFiles.purchaseOrderId, id),
				isNull(purchaseOrderFiles.removedAt),
			),
		)
		.limit(1);
	if (live)
		throw new PurchaseOrderError(
			`${poName(id)} has files on it; remove them first`,
		);
	await tx
		.delete(purchaseOrderFiles)
		.where(eq(purchaseOrderFiles.purchaseOrderId, id));
	await tx.delete(poFileUploads).where(eq(poFileUploads.purchaseOrderId, id));
}

// Undoes deleteDraft: the same draft, under the same PO number. It can't come
// back once its supplier has a new draft.
export async function restoreDraft(db: Db, draft: DeletedDraft) {
	return db.transaction(async (tx) => {
		const [other] = await currentDraft(tx, draft.supplierId);
		if (other?.status === "draft")
			throw new PurchaseOrderError(
				`Can't bring back ${poName(draft.id)}: its supplier has a new draft, ${poName(other.id)}`,
			);
		// A suggested PO is only a look at the suggestion; the draft takes its
		// place.
		if (other) {
			await tx
				.delete(purchaseOrderLines)
				.where(eq(purchaseOrderLines.purchaseOrderId, other.id));
			await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, other.id));
		}
		const [po] = await tx
			.insert(purchaseOrders)
			.overridingSystemValue()
			.values({
				id: draft.id,
				supplierId: draft.supplierId,
				locationId: draft.locationId,
				notes: draft.notes,
				createdAt: new Date(draft.createdAt),
			})
			.onConflictDoNothing()
			.returning({ id: purchaseOrders.id });
		if (!po)
			throw new PurchaseOrderError(`${poName(draft.id)} is already back`);
		for (const { discounts, ...l } of draft.lines) {
			const [line] = await tx
				.insert(purchaseOrderLines)
				.values({ ...l, purchaseOrderId: po.id })
				.returning({ id: purchaseOrderLines.id });
			if (discounts.length > 0)
				await tx
					.insert(purchaseOrderDiscounts)
					.values(
						discounts.map((d) => ({ lineId: line.id, ...discountRow(d) })),
					);
			await checkDiscounts(tx, line.id);
		}
		if (draft.skippedParts.length > 0)
			await tx
				.insert(purchaseOrderSkippedParts)
				.values(
					draft.skippedParts.map((s) => ({ ...s, purchaseOrderId: po.id })),
				);
	});
}
