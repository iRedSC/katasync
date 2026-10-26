import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	products,
	purchaseOrderDiscounts,
	purchaseOrderExcludedCatalogs,
	purchaseOrderLines,
	purchaseOrders,
	supplierCatalogs,
} from "#/db/schema";
import {
	type SuggestedLine,
	type SuggestionSettings,
	suggestionFor,
} from "#/purchasing/reorder";
import { checkDiscounts } from "./discount-checks";
import { pinPrice } from "./lines";
import { lockForEdit, PurchaseOrderError } from "./lock";
import { partsOfSets } from "./set-parts";
import { lockSuggestions, onOtherDrafts, settingsOf } from "./suggestions";

// A PO's Reorder dialog: new settings, previewed, then applied. Unlike
// Update, which only adds and raises, applying makes the draft match the
// suggestion: unlocked lines follow it up or down, and unlocked ones it no
// longer wants come off. Locked lines and tool sets stay as they are. It
// hands back what it changed, so Undo can put it all back.

type DraftLine = {
	productId: number;
	quantity: number;
	packSize: number;
	locked: boolean;
	kind: string;
};

export type SyncPlan = {
	added: SuggestedLine[];
	// Each line's new quantity, in its own unit.
	changed: { productId: number; from: number; to: number }[];
	removed: number[];
};

// How a draft changes to match `suggested`. Amounts compare as the product
// itself, since a line may be in another unit than the suggestion, and a
// part already coming in one of the draft's sets (fromSets) isn't ordered
// twice. Locked lines and sets are left alone.
export function syncPlan(
	draft: DraftLine[],
	suggested: SuggestedLine[],
	fromSets: Map<number, number>,
): SyncPlan {
	const onDraft = new Map(draft.map((l) => [l.productId, l]));
	const wanted = new Map<number, number>();
	const plan: SyncPlan = { added: [], changed: [], removed: [] };
	for (const s of suggested) {
		const want = s.quantity * s.packSize - (fromSets.get(s.productId) ?? 0);
		if (want <= 0) continue;
		wanted.set(s.productId, want);
		const line = onDraft.get(s.productId);
		if (!line)
			plan.added.push({
				...s,
				quantity: Math.max(Math.ceil(want / s.packSize), s.minimumQuantity),
			});
		else if (!line.locked) {
			const to = Math.ceil(want / line.packSize);
			if (to !== line.quantity)
				plan.changed.push({ productId: s.productId, from: line.quantity, to });
		}
	}
	for (const l of draft)
		if (!l.locked && l.kind !== "bundle" && !wanted.has(l.productId))
			plan.removed.push(l.productId);
	return plan;
}

export function summarize(plan: SyncPlan) {
	return {
		added: plan.added.length,
		raised: plan.changed.filter((c) => c.to > c.from).length,
		lowered: plan.changed.filter((c) => c.to < c.from).length,
		removed: plan.removed.length,
	};
}

async function checkSettings(
	db: Db,
	supplierId: number,
	settings: SuggestionSettings,
) {
	const days = settings.coverDays;
	if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 365))
		throw new PurchaseOrderError(`Cover days must be 1 to 365, got ${days}`);
	const carried = await db
		.select({ catalogId: supplierCatalogs.catalogId })
		.from(supplierCatalogs)
		.where(eq(supplierCatalogs.supplierId, supplierId));
	const left = new Set(settings.excludedCatalogs);
	if (carried.length > 0 && carried.every((c) => left.has(c.catalogId)))
		throw new PurchaseOrderError("Leave at least one catalog in");
}

async function draftLines(db: Db, purchaseOrderId: number) {
	return db
		.select({
			productId: purchaseOrderLines.productId,
			quantity: purchaseOrderLines.quantity,
			packSize: purchaseOrderLines.packSize,
			locked: purchaseOrderLines.locked,
			kind: products.kind,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
}

async function supplierOf(db: Db, purchaseOrderId: number) {
	const [po] = await db
		.select({
			supplierId: purchaseOrders.supplierId,
			status: purchaseOrders.status,
		})
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, purchaseOrderId));
	if (!po) throw new PurchaseOrderError(`PO ${purchaseOrderId} doesn't exist`);
	if (po.status !== "draft" && po.status !== "suggested")
		throw new PurchaseOrderError(`PO ${purchaseOrderId} is ${po.status}`);
	return po.supplierId;
}

// What applying `settings` would do to the PO now, without doing it.
export async function previewSettings(
	db: Db,
	purchaseOrderId: number,
	settings: SuggestionSettings,
	now = new Date(),
) {
	const supplierId = await supplierOf(db, purchaseOrderId);
	await checkSettings(db, supplierId, settings);
	const [suggested, lines, fromSets] = await Promise.all([
		suggestionFor(db, supplierId, settings, now),
		draftLines(db, purchaseOrderId),
		partsOfSets(db, purchaseOrderId),
	]);
	return summarize(syncPlan(lines, suggested, fromSets));
}

type LineRow = typeof purchaseOrderLines.$inferSelect;
type DiscountRow = typeof purchaseOrderDiscounts.$inferSelect;

// What a line was left as, so undo can tell whether it changed since.
type Left = { quantity: number; unit: string; packSize: number };

// Everything applying changed, to put back with restoreSettings.
export type SettingsUndo = {
	settings: SuggestionSettings;
	// Lines it changed or took off, as they were; `left` is what a changed
	// one became, null for one taken off.
	lines: (Omit<LineRow, "id"> & {
		left: Left | null;
		discounts: Omit<DiscountRow, "id" | "lineId">[];
	})[];
	// Lines it put on, as it put them.
	added: ({ productId: number } & Left)[];
};

async function saveSettings(
	db: Db,
	purchaseOrderId: number,
	settings: SuggestionSettings,
) {
	await db
		.update(purchaseOrders)
		.set({
			coverDays: settings.coverDays,
			includePricier: settings.includePricier,
		})
		.where(eq(purchaseOrders.id, purchaseOrderId));
	await db
		.delete(purchaseOrderExcludedCatalogs)
		.where(eq(purchaseOrderExcludedCatalogs.purchaseOrderId, purchaseOrderId));
	if (settings.excludedCatalogs.length > 0)
		await db.insert(purchaseOrderExcludedCatalogs).values(
			[...new Set(settings.excludedCatalogs)].map((catalogId) => ({
				purchaseOrderId,
				catalogId,
			})),
		);
}

// Saves the PO's settings and makes its lines match their suggestion. A
// suggested PO becomes a draft, as with any change.
export async function applySettings(
	db: Db,
	purchaseOrderId: number,
	settings: SuggestionSettings,
	now = new Date(),
) {
	const supplierId = await supplierOf(db, purchaseOrderId);
	await checkSettings(db, supplierId, settings);
	const [before, suggested] = await Promise.all([
		settingsOf(db, purchaseOrderId),
		suggestionFor(db, supplierId, settings, now),
	]);
	return db.transaction(async (tx) => {
		const po = await lockForEdit(tx, purchaseOrderId);
		if (po.supplierId !== supplierId)
			throw new PurchaseOrderError("The PO changed meanwhile; try again");
		await lockSuggestions(tx);
		const planned = syncPlan(
			await draftLines(tx, po.id),
			suggested,
			await partsOfSets(tx, po.id),
		);
		// Put on another draft since the suggestion was worked out.
		const taken = await onOtherDrafts(
			tx,
			supplierId,
			planned.added.map((l) => l.productId),
		);
		const plan = {
			...planned,
			added: planned.added.filter((l) => !taken.has(l.productId)),
		};
		const touched = [...plan.changed.map((c) => c.productId), ...plan.removed];
		const old =
			touched.length === 0
				? []
				: await tx
						.select()
						.from(purchaseOrderLines)
						.where(
							and(
								eq(purchaseOrderLines.purchaseOrderId, po.id),
								inArray(purchaseOrderLines.productId, touched),
							),
						);
		const discounts =
			old.length === 0
				? []
				: await tx
						.select()
						.from(purchaseOrderDiscounts)
						.where(
							inArray(
								purchaseOrderDiscounts.lineId,
								old.map((l) => l.id),
							),
						);
		const to = new Map(plan.changed.map((c) => [c.productId, c.to]));
		const undo: SettingsUndo = {
			settings: before,
			lines: old.map(({ id, ...line }) => {
				const quantity = to.get(line.productId);
				return {
					...line,
					left:
						quantity === undefined
							? null
							: { quantity, unit: line.unit, packSize: line.packSize },
					discounts: discounts
						.filter((d) => d.lineId === id)
						.map(({ id: _, lineId: __, ...d }) => d),
				};
			}),
			added: plan.added.map((l) => ({
				productId: l.productId,
				quantity: l.quantity,
				unit: l.unit,
				packSize: l.packSize,
			})),
		};

		await saveSettings(tx, po.id, settings);
		if (plan.removed.length > 0)
			await tx
				.delete(purchaseOrderLines)
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, po.id),
						inArray(purchaseOrderLines.productId, plan.removed),
					),
				);
		if (plan.added.length > 0)
			await tx.insert(purchaseOrderLines).values(
				plan.added.map((l) => ({
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
		if (plan.changed.length > 0)
			await tx
				.update(purchaseOrderLines)
				.set({
					quantity: sql`case ${purchaseOrderLines.productId} ${sql.join(
						plan.changed.map((c) => sql`when ${c.productId} then ${c.to}`),
						sql` `,
					)} end::int`,
				})
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, po.id),
						inArray(
							purchaseOrderLines.productId,
							plan.changed.map((c) => c.productId),
						),
					),
				);
		// A lower quantity may no longer hold a discount's units.
		for (const line of old)
			if (to.has(line.productId)) await checkDiscounts(tx, line.id);
		return { ...summarize(plan), undo };
	});
}

// Puts back what applySettings changed: the old settings, lines it took off
// (with their discounts and place in the list), old quantities, and none of
// what it added. A line changed since (its quantity or unit isn't what
// applying left) keeps that change, and so does one put back by hand.
// Returns how many lines were kept that way.
export async function restoreSettings(
	db: Db,
	purchaseOrderId: number,
	undo: SettingsUndo,
) {
	return db.transaction(async (tx) => {
		const po = await lockForEdit(tx, purchaseOrderId);
		await saveSettings(tx, po.id, undo.settings);
		const now = new Map(
			(
				await tx
					.select({
						id: purchaseOrderLines.id,
						productId: purchaseOrderLines.productId,
						quantity: purchaseOrderLines.quantity,
						unit: purchaseOrderLines.unit,
						packSize: purchaseOrderLines.packSize,
					})
					.from(purchaseOrderLines)
					.where(eq(purchaseOrderLines.purchaseOrderId, po.id))
			).map((l) => [l.productId, l]),
		);
		const same = (productId: number, left: Left) => {
			const l = now.get(productId);
			return (
				l !== undefined &&
				l.quantity === left.quantity &&
				l.unit === left.unit &&
				l.packSize === left.packSize
			);
		};
		let kept = 0;
		const untouched = undo.added.filter((a) => same(a.productId, a));
		kept +=
			undo.added.filter((a) => now.has(a.productId)).length - untouched.length;
		if (untouched.length > 0)
			await tx.delete(purchaseOrderLines).where(
				and(
					eq(purchaseOrderLines.purchaseOrderId, po.id),
					inArray(
						purchaseOrderLines.productId,
						untouched.map((a) => a.productId),
					),
				),
			);
		for (const { left, discounts, ...line } of undo.lines) {
			if (left) {
				const current = now.get(line.productId);
				if (!current || !same(line.productId, left)) {
					kept++;
					continue;
				}
				await tx
					.update(purchaseOrderLines)
					.set({ quantity: line.quantity })
					.where(eq(purchaseOrderLines.id, current.id));
				await checkDiscounts(tx, current.id);
				continue;
			}
			const [back] = await tx
				.insert(purchaseOrderLines)
				.values({ ...line, purchaseOrderId: po.id })
				.onConflictDoNothing()
				.returning({ id: purchaseOrderLines.id });
			if (!back) {
				kept++;
				continue;
			}
			await pinPrice(tx, back.id, line.unitCost);
			if (discounts.length > 0)
				await tx
					.insert(purchaseOrderDiscounts)
					.values(discounts.map((d) => ({ ...d, lineId: back.id })));
		}
		return { kept };
	});
}
