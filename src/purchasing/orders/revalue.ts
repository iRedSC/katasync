import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	costEntries,
	products,
	purchaseOrderCharges,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
} from "#/db/schema";
import { heldOf, lockCost, postValue } from "#/inventory/valuation";
import { lineCents, receiptUnitCost } from "#/purchasing/discount";
import { type Split, splitCharges, splitItems } from "#/purchasing/landed";
import { lineDiscounts } from "./discount-checks";
import { poName } from "./lock";

// What a PO's received stock is worth, kept in step with the PO. Each line's
// received items are worth their price after discounts plus their share of
// the PO's charges. After anything that changes that (a receipt, its undo, a
// price or quantity fixed, a discount, a charge) the difference between that
// and what's been posted for the line is posted, so a mistake fixed on the PO
// is fixed in the cost too. Call with the PO locked.

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

type Line = {
	id: number;
	productId: number;
	packSize: number;
	quantity: number;
	unitCost: number | null;
	gramsEach: number | null;
};

// The PO's lines, what came of each, their discounts, and how its charges
// spread over them.
export async function landedTerms(db: Db, purchaseOrderId: number) {
	const [po] = await db
		.select({ status: purchaseOrders.status })
		.from(purchaseOrders)
		.where(eq(purchaseOrders.id, purchaseOrderId));
	const lines: Line[] = await db
		.select({
			id: purchaseOrderLines.id,
			productId: purchaseOrderLines.productId,
			packSize: purchaseOrderLines.packSize,
			quantity: purchaseOrderLines.quantity,
			unitCost: purchaseOrderLines.unitCost,
			gramsEach: products.weightGrams,
		})
		.from(purchaseOrderLines)
		.innerJoin(products, eq(products.id, purchaseOrderLines.productId))
		.where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
		.orderBy(purchaseOrderLines.id);
	const ids = lines.map((l) => l.id);
	const receipts =
		ids.length === 0
			? []
			: await db
					.select({
						id: purchaseOrderReceipts.id,
						lineId: purchaseOrderReceipts.lineId,
						quantity: purchaseOrderReceipts.quantity,
						undoesId: purchaseOrderReceipts.undoesId,
						batchId: purchaseOrderReceipts.batchId,
					})
					.from(purchaseOrderReceipts)
					.where(inArray(purchaseOrderReceipts.lineId, ids));
	const undone = new Set(receipts.map((r) => r.undoesId));
	const standing = receipts.filter((r) => r.quantity > 0 && !undone.has(r.id));
	// Receipts with a value posted here; ones from before costs were kept
	// (drizzle/0114) have none.
	const valued = new Set(
		standing.length === 0
			? []
			: (
					await db
						.select({ batchId: costEntries.batchId })
						.from(costEntries)
						.where(
							and(
								eq(costEntries.kind, "receipt"),
								inArray(
									costEntries.batchId,
									standing.map((r) => r.batchId),
								),
							),
						)
				).map((e) => e.batchId),
	);
	const tracked = standing.filter((r) => valued.has(r.batchId));
	const received = (lineId: number) =>
		standing
			.filter((r) => r.lineId === lineId)
			.reduce((n, r) => n + r.quantity, 0);
	const discounts = await lineDiscounts(db, ids);
	const discountsOf = (lineId: number) =>
		discounts.filter((d) => d.lineId === lineId);
	const [charges] = await db
		.select({
			total: sql<number>`coalesce(sum(${purchaseOrderCharges.amount}), 0)::float8`,
		})
		.from(purchaseOrderCharges)
		.where(eq(purchaseOrderCharges.purchaseOrderId, purchaseOrderId));
	const closed = po?.status === "closed";
	const split = splitCharges(
		charges.total,
		lines.map((l) => {
			const items = splitItems(l, received(l.id), closed);
			const cents = lineCents(l, discountsOf(l.id));
			const units = items / l.packSize;
			return {
				lineId: l.id,
				items,
				gramsEach: l.gramsEach,
				cents:
					cents === null || l.unitCost === null
						? null
						: l.quantity > 0
							? (cents / l.quantity) * units
							: Math.round(l.unitCost * units * 100),
			};
		}),
	);
	return {
		lines,
		standing,
		tracked,
		received,
		discountsOf,
		split,
		charges: charges.total,
	};
}

// What one line's received items are worth, or null with no price.
export function lineWorth(
	line: Line,
	standing: { id: number; lineId: number; quantity: number }[],
	discounts: ReturnType<Awaited<ReturnType<typeof landedTerms>>["discountsOf"]>,
	split: Split,
) {
	if (line.unitCost === null) return null;
	const unitCost = line.unitCost;
	const mine = standing.filter((r) => r.lineId === line.id);
	const items = mine.reduce((n, r) => n + r.quantity, 0) * line.packSize;
	const goods = mine.reduce(
		(n, r) =>
			n +
			r.quantity *
				receiptUnitCost({
					line: { quantity: line.quantity, unitCost },
					discounts,
					receipt: { id: r.id, quantity: r.quantity },
				}),
		0,
	);
	return r4(goods + items * (split.perItem.get(line.id) ?? 0));
}

export async function revaluePurchaseOrder(db: Db, purchaseOrderId: number) {
	const terms = await landedTerms(db, purchaseOrderId);
	const ids = terms.lines.map((l) => l.id);
	if (ids.length === 0) return;
	const posted = await db
		.select({
			lineId: costEntries.purchaseOrderLineId,
			value: sql<number>`coalesce(sum(${costEntries.value}), 0)::float8`,
			lastReceipt: sql<
				number | null
			>`max(${costEntries.id}) filter (where ${costEntries.kind} = 'receipt')`,
		})
		.from(costEntries)
		.where(inArray(costEntries.purchaseOrderLineId, ids))
		.groupBy(costEntries.purchaseOrderLineId);
	const tracked = new Set(terms.tracked.map((r) => r.id));
	for (const line of terms.lines) {
		const was = posted.find((p) => p.lineId === line.id);
		const standing = terms.standing.filter((r) => r.lineId === line.id);
		if (!was && standing.length === 0) continue;
		const discounts = terms.discountsOf(line.id);
		const target = lineWorth(line, standing, discounts, terms.split);
		if (target === null) continue;
		// Receipts from before costs were kept (drizzle/0114) went into the
		// average at their price after discounts, which is taken as posted:
		// what changes since, their share of charges above all, still lands.
		const legacy = standing.filter((r) => !tracked.has(r.id));
		const before =
			lineWorth(line, legacy, discounts, {
				...terms.split,
				perItem: new Map(),
			}) ?? 0;
		const diff = r4(target - before - (was?.value ?? 0));
		if (Math.abs(diff) < 0.005) continue;
		const items = standing.reduce((n, r) => n + r.quantity, 0) * line.packSize;
		// Locked before reading what's on the shelf, so the split holds.
		await lockCost(db, line.productId);
		await postValue(db, {
			productId: line.productId,
			kind: "po_correction",
			value: diff,
			share: await shareOnShelf(
				db,
				line.productId,
				items,
				was?.lastReceipt ?? null,
			),
			perItem: items > 0 ? target / items : null,
			purchaseOrderLineId: line.id,
			note: poName(purchaseOrderId),
		});
	}
}

// What one receipt is worth under the PO as it is now, for undoing it: its
// original value plus what's been corrected since. Null with no price, or
// for a receipt from before costs were kept.
export async function receiptWorth(
	db: Db,
	purchaseOrderId: number,
	receiptId: number,
) {
	const terms = await landedTerms(db, purchaseOrderId);
	const receipt = terms.tracked.find((r) => r.id === receiptId);
	const line = receipt && terms.lines.find((l) => l.id === receipt.lineId);
	if (!receipt || !line) return null;
	return lineWorth(line, [receipt], terms.discountsOf(line.id), terms.split);
}

// How much of a line's items are likely still on the shelf: what's there,
// less what came in since the line's last delivery (the oldest goes first).
async function shareOnShelf(
	db: Db,
	productId: number,
	items: number,
	lastReceipt: number | string | null,
) {
	if (items <= 0) return 0;
	const [since] =
		lastReceipt === null
			? [{ units: 0 }]
			: await db
					.select({
						units: sql<number>`coalesce(sum(${costEntries.units}) filter (where ${costEntries.units} > 0), 0)::int`,
					})
					.from(costEntries)
					.where(
						and(
							eq(costEntries.productId, productId),
							gt(costEntries.id, Number(lastReceipt)),
						),
					);
	const held = await heldOf(db, productId);
	return Math.min(items, Math.max(0, held - since.units)) / items;
}
