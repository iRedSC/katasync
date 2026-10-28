import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	poFileUploads,
	purchaseOrderAmendments,
	purchaseOrderCharges,
	purchaseOrderDiscounts,
	purchaseOrderExcludedCatalogs,
	purchaseOrderFiles,
	purchaseOrderLines,
	purchaseOrderSkippedParts,
	purchaseOrders,
} from "#/db/schema";
import { discountRow } from "#/purchasing/discount";
import { checkDiscounts, lineDiscounts } from "./discount-checks";
import { currentDraft } from "./drafts";
import { pinPrice } from "./lines";
import { lockOrder, PurchaseOrderError, poName } from "./lock";
import { checkPrice } from "./price";
import type { DeletedDraft } from "./types";

// Throws a draft away, lines and all. Nothing was sent, so there's no record
// worth keeping. Checked under the lock, so a PO sent a moment ago stays.
// Returns what was thrown away, for restoreDraft to put back.
export async function deleteDraft(db: Db, id: number): Promise<DeletedDraft> {
	return db.transaction(async (tx) => {
		const po = await lockOrder(tx, id, ["draft"]);
		const rows = await tx
			.select()
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, id))
			.orderBy(purchaseOrderLines.id);
		const discounts = await lineDiscounts(
			tx,
			rows.map((l) => l.id),
		);
		// What only a sent line has stays behind.
		const lines = rows.map(
			({
				id: lineId,
				purchaseOrderId: _po,
				sentQuantity: _sentQuantity,
				sentUnitCost: _sentUnitCost,
				receivingNote: _receivingNote,
				backOrderedAt: _backOrderedAt,
				...l
			}) => ({
				...l,
				discounts: discounts
					.filter((d) => d.lineId === lineId)
					.map(({ units, off }) => ({ units, off })),
			}),
		);
		const charges = await tx
			.select({
				kind: purchaseOrderCharges.kind,
				amount: purchaseOrderCharges.amount,
				createdAt: purchaseOrderCharges.createdAt,
			})
			.from(purchaseOrderCharges)
			.where(eq(purchaseOrderCharges.purchaseOrderId, id))
			.orderBy(purchaseOrderCharges.id);
		const excludedCatalogIds = (
			await tx
				.select({ catalogId: purchaseOrderExcludedCatalogs.catalogId })
				.from(purchaseOrderExcludedCatalogs)
				.where(eq(purchaseOrderExcludedCatalogs.purchaseOrderId, id))
		).map((e) => e.catalogId);
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
		const {
			status: _status,
			sentAt: _sentAt,
			sentTo: _sentTo,
			expectedAt: _expectedAt,
			closedAt: _closedAt,
			...columns
		} = po;
		return { ...columns, lines, charges, excludedCatalogIds, skippedParts };
	});
}

// A draft or suggested PO is only thrown away once its files are off it (Undo
// couldn't bring them back); ones already removed, and its upload links, go
// with it, expired or not.
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
	// Refused before anything is touched, the same as a new line's price.
	for (const l of draft.lines) checkPrice(l.unitCost);
	const { lines, charges, excludedCatalogIds, skippedParts, ...columns } =
		draft;
	return db.transaction(async (tx) => {
		const [other] = await currentDraft(tx, draft.supplierId);
		if (other?.status === "draft")
			throw new PurchaseOrderError(
				`Can't bring back ${poName(draft.id)}: its supplier has a new draft, ${poName(other.id)}`,
			);
		// A suggested PO is only a look at the suggestion; the draft takes its
		// place. Its files and upload links go in this transaction too, so a
		// refused restore leaves them where they were.
		if (other) {
			await dropFiles(tx, other.id);
			await tx
				.delete(purchaseOrderLines)
				.where(eq(purchaseOrderLines.purchaseOrderId, other.id));
			await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, other.id));
		}
		const [po] = await tx
			.insert(purchaseOrders)
			.overridingSystemValue()
			.values({
				...columns,
				createdAt: new Date(columns.createdAt),
			})
			.onConflictDoNothing()
			.returning({ id: purchaseOrders.id });
		if (!po)
			throw new PurchaseOrderError(`${poName(draft.id)} is already back`);
		for (const { discounts, ...l } of lines) {
			const [line] = await tx
				.insert(purchaseOrderLines)
				.values({
					...l,
					purchaseOrderId: po.id,
					addedAt: new Date(l.addedAt),
				})
				.returning({ id: purchaseOrderLines.id });
			await pinPrice(tx, line.id, l.unitCost);
			if (discounts.length > 0)
				await tx
					.insert(purchaseOrderDiscounts)
					.values(
						discounts.map((d) => ({ lineId: line.id, ...discountRow(d) })),
					);
			await checkDiscounts(tx, line.id);
		}
		if (charges.length > 0)
			await tx.insert(purchaseOrderCharges).values(
				charges.map((c) => ({
					...c,
					purchaseOrderId: po.id,
					createdAt: new Date(c.createdAt),
				})),
			);
		if (excludedCatalogIds.length > 0)
			await tx.insert(purchaseOrderExcludedCatalogs).values(
				excludedCatalogIds.map((catalogId) => ({
					purchaseOrderId: po.id,
					catalogId,
				})),
			);
		if (skippedParts.length > 0)
			await tx
				.insert(purchaseOrderSkippedParts)
				.values(skippedParts.map((s) => ({ ...s, purchaseOrderId: po.id })));
	});
}
