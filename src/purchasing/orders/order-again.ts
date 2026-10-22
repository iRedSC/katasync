import { eq, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productSuppliers, products, purchaseOrderLines } from "#/db/schema";
import { openDraft } from "./drafts";
import { lockOrder, PurchaseOrderError, poName } from "./lock";
import { addItemsBatch } from "./set-parts";

// Puts a finished PO's products on its supplier's draft again, in what was
// sent (or, for lines never sent, what the PO ended up expecting). Each comes
// in at today's terms and price, rounded up to whole units. Products already
// on the draft keep their line, and products that have since moved to another
// supplier are left off, so nothing is ordered twice or from the wrong place.
// Archived products are left off too.
export async function orderAgain(db: Db, sourceId: number) {
	const reorderable = async (tx: Db) => {
		const from = await lockOrder(tx, sourceId, ["closed", "cancelled"]);
		const lines = await tx
			.select({
				productId: purchaseOrderLines.productId,
				items: sql<number>`(coalesce(${purchaseOrderLines.sentQuantity}, ${purchaseOrderLines.quantity}) * ${purchaseOrderLines.packSize})::int`,
				supplierId: productSuppliers.supplierId,
				archived: sql<boolean>`${products.archivedAt} is not null`,
			})
			.from(purchaseOrderLines)
			.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
			.leftJoin(
				productSuppliers,
				eq(productSuppliers.productId, purchaseOrderLines.productId),
			)
			.where(eq(purchaseOrderLines.purchaseOrderId, from.id))
			.orderBy(purchaseOrderLines.id);
		return { from, lines: lines.filter((l) => l.items > 0) };
	};
	// Checked before opening the draft, so a PO with nothing left to order
	// doesn't leave an empty draft behind.
	const first = await db.transaction(reorderable);
	if (
		!first.lines.some(
			(l) => l.supplierId === first.from.supplierId && !l.archived,
		)
	)
		throw new PurchaseOrderError(
			`Nothing on ${poName(sourceId)} is still bought from this supplier`,
		);
	const draftId = await openDraft(db, first.from.supplierId);
	return db.transaction(async (tx) => {
		const { from, lines } = await reorderable(tx);
		await lockOrder(tx, draftId, ["draft"]);
		const onDraft = new Set(
			(
				await tx
					.select({ productId: purchaseOrderLines.productId })
					.from(purchaseOrderLines)
					.where(eq(purchaseOrderLines.purchaseOrderId, draftId))
			).map((l) => l.productId),
		);
		let added = 0;
		let alreadyOn = 0;
		let moved = 0;
		let archived = 0;
		const toAdd = new Map<number, number>();
		for (const l of lines) {
			if (l.archived) archived++;
			else if (l.supplierId !== from.supplierId) moved++;
			else if (onDraft.has(l.productId)) alreadyOn++;
			else {
				toAdd.set(l.productId, l.items);
				onDraft.add(l.productId);
				added++;
			}
		}
		await addItemsBatch(tx, draftId, toAdd);
		return { id: draftId, added, alreadyOn, moved, archived };
	});
}
