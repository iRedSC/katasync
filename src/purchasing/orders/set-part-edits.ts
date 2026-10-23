import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { purchaseOrderLines, purchaseOrderSkippedParts } from "#/db/schema";
import { partState, setsOf, shortBySupplier } from "#/purchasing/sets";
import { openDraft } from "./drafts";
import { newLine } from "./lines";
import { lockForEdit, PurchaseOrderError } from "./lock";
import { setLineParts } from "./set-parts";

// Skips one part of a draft's tool set, or orders it again. Only a part
// bought from the draft's supplier can be skipped: this is the PO that orders
// it. A skipped part isn't ordered for this PO's set and doesn't count as
// missing. Old skips of parts bought elsewhere (moves) can still be undone.
export async function skipSetPart(
	db: Db,
	input: { lineId: number; productId: number; skipped: boolean },
) {
	return db.transaction(async (tx) => {
		const [found] = await tx
			.select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.id, input.lineId));
		if (!found) throw new PurchaseOrderError("That line doesn't exist");
		await lockForEdit(tx, found.purchaseOrderId);
		const line = await setLineParts(tx, input.lineId);
		const part = line.parts.find((p) => p.productId === input.productId);
		if (!part)
			throw new PurchaseOrderError(`That product isn't part of ${line.sku}`);
		// Skipping elsewhere would only hide the part's warning here, while its
		// supplier's PO still orders it.
		if (input.skipped && part.supplierId !== line.supplierId)
			throw new PurchaseOrderError(
				part.supplierName === null
					? `${part.sku} has no supplier yet; set one on its page`
					: `${part.sku} is bought from ${part.supplierName}; skip it on their PO`,
			);
		const key = {
			purchaseOrderId: line.purchaseOrderId,
			setProductId: line.setProductId,
			partProductId: input.productId,
		};
		if (input.skipped)
			await tx
				.insert(purchaseOrderSkippedParts)
				.values(key)
				.onConflictDoNothing();
		else
			await tx
				.delete(purchaseOrderSkippedParts)
				.where(
					and(
						eq(purchaseOrderSkippedParts.purchaseOrderId, key.purchaseOrderId),
						eq(purchaseOrderSkippedParts.setProductId, key.setProductId),
						eq(purchaseOrderSkippedParts.partProductId, key.partProductId),
					),
				);
		return part.sku;
	});
}

// Puts a draft's tool set on the drafts of the other suppliers its parts are
// bought from, enough that each of their parts is ordered for every set here
// (counting what their open POs already have), opening drafts as needed. A
// part skipped on a supplier's draft is ordered there again, since this asks
// for it. Returns each draft it changed with how many sets it now has.
export async function addSetToOtherDrafts(
	db: Db,
	input: { lineId: number },
): Promise<{ purchaseOrderId: number; supplierName: string; sets: number }[]> {
	const before = await setLineParts(db, input.lineId);
	const suppliersShort = shortBySupplier(
		before.parts,
		before.sets,
		before.supplierId,
	);
	if (suppliersShort.size === 0)
		throw new PurchaseOrderError(
			`Every part of ${before.sku} bought elsewhere is already on order`,
		);
	const drafts = new Map<number, number>();
	for (const supplierId of suppliersShort.keys())
		drafts.set(supplierId, await openDraft(db, supplierId));
	return db.transaction(async (tx) => {
		// Lowest first, so two of these at once can't deadlock.
		for (const id of [before.purchaseOrderId, ...drafts.values()].sort(
			(a, b) => a - b,
		))
			await lockForEdit(tx, id);
		// Again under the locks, so it's what's on the POs now.
		const line = await setLineParts(tx, input.lineId);
		const added = [];
		for (const [supplierId, draftId] of drafts) {
			const theirs = line.parts.filter(
				(p) =>
					p.supplierId === supplierId &&
					partState(p, line.sets, line.supplierId).kind === "short",
			);
			if (theirs.length === 0) continue;
			// Enough sets on their draft that each part is ordered for every set
			// here, with what their other open POs already have.
			const want = Math.max(
				...theirs.map(
					(p) =>
						line.sets -
						p.elsewhere
							.filter((e) => e.purchaseOrderId !== draftId)
							.reduce((n, e) => n + e.sets, 0),
				),
			);
			const [existing] = await tx
				.select({
					id: purchaseOrderLines.id,
					quantity: purchaseOrderLines.quantity,
					packSize: purchaseOrderLines.packSize,
				})
				.from(purchaseOrderLines)
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, draftId),
						eq(purchaseOrderLines.productId, line.setProductId),
					),
				);
			let sets = existing ? setsOf(existing) : 0;
			if (existing && want > sets) {
				const quantity = Math.ceil(want / existing.packSize);
				await tx
					.update(purchaseOrderLines)
					.set({ quantity })
					.where(eq(purchaseOrderLines.id, existing.id));
				sets = quantity * existing.packSize;
			} else if (!existing) {
				const { terms } = await newLine(tx, line.setProductId, supplierId);
				const quantity = Math.ceil(want / terms.packSize);
				await tx.insert(purchaseOrderLines).values({
					purchaseOrderId: draftId,
					productId: line.setProductId,
					...terms,
					quantity,
					unitCost: null,
				});
				sets = quantity * terms.packSize;
			}
			await tx.delete(purchaseOrderSkippedParts).where(
				and(
					eq(purchaseOrderSkippedParts.purchaseOrderId, draftId),
					eq(purchaseOrderSkippedParts.setProductId, line.setProductId),
					inArray(
						purchaseOrderSkippedParts.partProductId,
						theirs.map((p) => p.productId),
					),
				),
			);
			added.push({
				purchaseOrderId: draftId,
				supplierName: theirs[0].supplierName ?? "",
				sets,
			});
		}
		return added;
	});
}
