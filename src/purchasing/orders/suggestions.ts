import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	purchaseOrderExcludedCatalogs,
	purchaseOrderLines,
	purchaseOrders,
} from "#/db/schema";
import { wantsMore } from "#/purchasing/changes";
import {
	type SuggestedLine,
	type SuggestionSettings,
	suggestionFor,
} from "#/purchasing/reorder";
import { currentDraft, firstLocation, openDraft } from "./drafts";
import { lockOrder, PurchaseOrderError } from "./lock";
import { partsOfSets } from "./set-parts";

// Opens the supplier's draft with today's suggestions in it, creating it if
// there isn't one.
export async function draftFromSuggestions(
	db: Db,
	supplierId: number,
	now = new Date(),
): Promise<number> {
	const id = await openDraft(db, supplierId);
	await updateFromSuggestions(db, id, now);
	return id;
}

// How today's suggestions differ from a draft. A draft is frozen once made:
// these are what "Update" would apply. New products are added, and lines the
// suggestion now wants more of are raised. Nothing is lowered or removed, so
// a quantity set by hand is never undone. A locked line is never raised; it's
// skipped instead. A line may be in a different unit from the suggestion (set
// on just this PO), so amounts compare as the product itself, and a raise is
// in the line's unit, rounded up. fromSets is what the draft's tool sets will
// add of each part when it's sent (partsOfSets), so a part already coming in a
// set isn't ordered twice. wants is, per product on the draft, how many single
// items the suggestion wants (see wantsMore).
export function draftChanges(
	draft: {
		productId: number;
		quantity: number;
		packSize: number;
		locked: boolean;
	}[],
	suggested: SuggestedLine[],
	fromSets: Map<number, number> = new Map(),
) {
	const onDraft = new Map(draft.map((l) => [l.productId, l]));
	const added: SuggestedLine[] = [];
	const raised: (SuggestedLine & { raiseTo: number })[] = [];
	const skipped: SuggestedLine[] = [];
	const wants = new Map<number, number>();
	for (const l of suggested) {
		const want = l.quantity * l.packSize - (fromSets.get(l.productId) ?? 0);
		const line = onDraft.get(l.productId);
		if (!line) {
			if (want > 0)
				added.push({
					...l,
					quantity: Math.max(Math.ceil(want / l.packSize), l.minimumQuantity),
				});
			continue;
		}
		wants.set(l.productId, want);
		if (!wantsMore({ ...line, wants: want })) continue;
		if (line.locked) skipped.push(l);
		else raised.push({ ...l, raiseTo: Math.ceil(want / line.packSize) });
	}
	return { added, raised, skipped, wants };
}

// What a PO's suggestions are worked out with (see SuggestionSettings).
export async function settingsOf(
	db: Db,
	purchaseOrderId: number,
): Promise<SuggestionSettings> {
	const [[po], excluded] = await Promise.all([
		db
			.select({
				coverDays: purchaseOrders.coverDays,
				includePricier: purchaseOrders.includePricier,
			})
			.from(purchaseOrders)
			.where(eq(purchaseOrders.id, purchaseOrderId)),
		db
			.select({ catalogId: purchaseOrderExcludedCatalogs.catalogId })
			.from(purchaseOrderExcludedCatalogs)
			.where(eq(purchaseOrderExcludedCatalogs.purchaseOrderId, purchaseOrderId))
			.orderBy(purchaseOrderExcludedCatalogs.catalogId),
	]);
	if (!po) throw new PurchaseOrderError(`PO ${purchaseOrderId} doesn't exist`);
	return { ...po, excludedCatalogs: excluded.map((e) => e.catalogId) };
}

// Taken by every change that puts suggested products on a draft, so two at
// once can't both see a product as on no other draft and add it (see
// onOtherDrafts). Held to the end of the transaction.
export async function lockSuggestions(tx: Db) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtext('katasync:suggestions'))`,
	);
}

// Which of these products are on another supplier's open draft. Suggestions
// leave those out (plannedFrom); checked again under lockSuggestions, since
// the suggestion was worked out before it.
export async function onOtherDrafts(
	tx: Db,
	supplierId: number,
	productIds: number[],
) {
	if (productIds.length === 0) return new Set<number>();
	const rows = await tx
		.select({ productId: purchaseOrderLines.productId })
		.from(purchaseOrderLines)
		.innerJoin(
			purchaseOrders,
			eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
		)
		.where(
			and(
				inArray(purchaseOrderLines.productId, productIds),
				eq(purchaseOrders.status, "draft"),
				ne(purchaseOrders.supplierId, supplierId),
			),
		);
	return new Set(rows.map((r) => r.productId));
}

// What a PO is suggested now, under its own settings.
export async function suggestionOf(
	db: Db,
	po: { id: number; supplierId: number },
	now = new Date(),
) {
	return suggestionFor(db, po.supplierId, await settingsOf(db, po.id), now);
}

// Applies draftChanges to a draft. Returns how many lines it added and raised.
export async function updateFromSuggestions(
	db: Db,
	purchaseOrderId: number,
	now = new Date(),
): Promise<{ added: number; raised: number }> {
	const [found] = await db
		.select({ supplierId: purchaseOrders.supplierId })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, purchaseOrderId));
	if (!found)
		throw new PurchaseOrderError(`PO ${purchaseOrderId} doesn't exist`);
	const suggested = await suggestionOf(
		db,
		{ id: purchaseOrderId, supplierId: found.supplierId },
		now,
	);
	return db.transaction(async (tx) => {
		// Locked, so it can't be sent or cancelled while lines change.
		const po = await lockOrder(tx, purchaseOrderId, ["draft"]);
		await lockSuggestions(tx);
		const current = await tx
			.select({
				productId: purchaseOrderLines.productId,
				quantity: purchaseOrderLines.quantity,
				packSize: purchaseOrderLines.packSize,
				locked: purchaseOrderLines.locked,
			})
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, po.id));
		const changes = draftChanges(
			current,
			suggested,
			await partsOfSets(tx, po.id),
		);
		const taken = await onOtherDrafts(
			tx,
			po.supplierId,
			changes.added.map((l) => l.productId),
		);
		const added = changes.added.filter((l) => !taken.has(l.productId));
		const { raised } = changes;
		if (added.length > 0)
			await tx.insert(purchaseOrderLines).values(
				added.map((l) => ({
					purchaseOrderId: po.id,
					productId: l.productId,
					unit: l.unit,
					packSize: l.packSize,
					supplierCount: l.supplierCount,
					minimumQuantity: l.minimumQuantity,
					quantity: l.quantity,
					unitCost: l.unitCost,
				})),
			);
		// One statement raises them all, each line to its own quantity.
		if (raised.length > 0)
			await tx
				.update(purchaseOrderLines)
				.set({
					quantity: sql`case ${purchaseOrderLines.productId} ${sql.join(
						raised.map((l) => sql`when ${l.productId} then ${l.raiseTo}`),
						sql` `,
					)} end::int`,
				})
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, po.id),
						inArray(
							purchaseOrderLines.productId,
							raised.map((l) => l.productId),
						),
					),
				);
		return { added: added.length, raised: raised.length };
	});
}

// The supplier's suggested PO, matching today's suggestion, so its
// suggestion opens on the PO page. Nothing is a draft until it's changed
// (lockForEdit). A supplier with a draft already gets that instead.
export async function openSuggested(
	db: Db,
	supplierId: number,
	now = new Date(),
): Promise<number> {
	const id = await db.transaction(async (tx): Promise<number> => {
		const [existing] = await currentDraft(tx, supplierId);
		if (existing) return existing.id;
		const [po] = await tx
			.insert(purchaseOrders)
			.values({
				supplierId,
				locationId: await firstLocation(tx),
				status: "suggested",
			})
			.onConflictDoNothing()
			.returning({ id: purchaseOrders.id });
		if (po) return po.id;
		return (await currentDraft(tx, supplierId))[0].id;
	});
	await refreshSuggested(db, id, now);
	return id;
}

// Makes a suggested PO's lines match today's suggestion for its supplier:
// lines it no longer suggests go, changed ones follow it, new ones are added.
// Lines keep their ids, so an edit made from what's shown still finds its
// line. Leaves any other PO alone.
export async function refreshSuggested(db: Db, id: number, now = new Date()) {
	const [po] = await db
		.select({
			status: purchaseOrders.status,
			supplierId: purchaseOrders.supplierId,
		})
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, id));
	if (po?.status !== "suggested") return;
	const want = await suggestionOf(db, { id, supplierId: po.supplierId }, now);
	await db.transaction(async (tx) => {
		// Checked again under the lock: an edit may have made it a draft.
		const locked = await lockOrder(tx, id, [
			"suggested",
			"draft",
			"sent",
			"closed",
			"cancelled",
		]);
		if (locked.status !== "suggested") return;
		const current = await tx
			.select()
			.from(purchaseOrderLines)
			.where(eq(purchaseOrderLines.purchaseOrderId, id));
		const onPo = new Map(current.map((c) => [c.productId, c]));
		const wanted = new Set(want.map((l) => l.productId));
		const gone = current.filter((c) => !wanted.has(c.productId));
		if (gone.length > 0)
			await tx.delete(purchaseOrderLines).where(
				inArray(
					purchaseOrderLines.id,
					gone.map((c) => c.id),
				),
			);
		// Only the lines that are new or differ are written, in one statement.
		// Each conflicts on its product, so a changed line keeps its id.
		const changed = want.flatMap((l) => {
			const terms = {
				unit: l.unit,
				packSize: l.packSize,
				supplierCount: l.supplierCount,
				minimumQuantity: l.minimumQuantity,
				quantity: l.quantity,
				unitCost: l.unitCost,
			};
			const line = onPo.get(l.productId);
			if (
				line &&
				line.unit === terms.unit &&
				line.packSize === terms.packSize &&
				line.supplierCount === terms.supplierCount &&
				line.minimumQuantity === terms.minimumQuantity &&
				line.quantity === terms.quantity &&
				line.unitCost === terms.unitCost
			)
				return [];
			return [{ purchaseOrderId: id, productId: l.productId, ...terms }];
		});
		if (changed.length > 0)
			await tx
				.insert(purchaseOrderLines)
				.values(changed)
				.onConflictDoUpdate({
					target: [
						purchaseOrderLines.purchaseOrderId,
						purchaseOrderLines.productId,
					],
					set: {
						unit: sql`excluded.unit`,
						packSize: sql`excluded.pack_size`,
						supplierCount: sql`excluded.supplier_count`,
						minimumQuantity: sql`excluded.minimum_quantity`,
						quantity: sql`excluded.quantity`,
						unitCost: sql`excluded.unit_cost`,
					},
				});
	});
}
