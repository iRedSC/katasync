import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { costEntries, products, stockLevels } from "#/db/schema";

// What stock is worth, as one moving average per product across every shelf
// (Amazon's too, so moving stock between them changes nothing). Selling,
// counting, damage and transfers take stock out at the average and leave it
// as it is; only what's posted here moves it. Each change is a cost entry,
// and every dollar of an entry lands either on the shelf or on goods already
// sold (soldValue), which profit counts when it's posted. This is the only
// code that writes products.unit_cost; a trigger records any other write.

type Kind = (typeof costEntries.$inferInsert)["kind"];

// Value that moves with stock in one ledger batch (postMovements). Units are
// single items, + in and - out. A null value comes in at the average.
export type CostLine = {
	productId: number;
	kind: Extract<
		Kind,
		"receipt" | "return" | "kit_build" | "kit_break" | "undo"
	>;
	units: number;
	value: number | null;
	purchaseOrderLineId?: number | null;
	note?: string;
};

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export type Applied = {
	value: number | null;
	avgAfter: number | null;
	soldValue: number;
};

// One entry against a product holding `held` items at `avg` each. Units in
// blend into the average. Value alone (units 0) puts `share` of it on the
// shelf and the rest on what's sold. Units out with a value take exactly that
// value off. What the shelf can't absorb (it's empty, or would go below $0)
// goes on what's sold, so value = shelf change + soldValue always holds.
// With no average yet, `perItem` is what the items in question cost.
export function applyCost(
	held: number,
	avg: number | null,
	entry: {
		units: number;
		value: number | null;
		share?: number;
		perItem?: number | null;
	},
): Applied {
	const h = Math.max(0, held);
	const { units } = entry;
	if (entry.value === null)
		return {
			value: avg === null || units === 0 ? null : r4(units * avg),
			avgAfter: avg,
			soldValue: 0,
		};
	const value = r4(entry.value);
	if (units > 0) {
		const blended =
			avg === null || h === 0 ? value / units : (h * avg + value) / (h + units);
		return { value, avgAfter: r4(Math.max(0, blended)), soldValue: 0 };
	}
	if (avg === null)
		// Nothing known to take it from or add it to: the best guess for every
		// item here is what these cost.
		return {
			value,
			avgAfter: h > 0 && entry.perItem != null ? r4(entry.perItem) : null,
			soldValue: 0,
		};
	const shelf = h * avg;
	const heldAfter = h + units;
	const wanted = units < 0 ? value : value * clamp01(entry.share ?? 1);
	let shelfChange: number;
	let avgAfter: number;
	if (heldAfter <= 0) {
		shelfChange = -shelf;
		avgAfter = avg;
	} else if (shelf + wanted < 0) {
		shelfChange = -shelf;
		avgAfter = 0;
	} else {
		shelfChange = wanted;
		avgAfter = (shelf + wanted) / heldAfter;
	}
	return { value, avgAfter: r4(avgAfter), soldValue: r4(value - shelfChange) };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Items of a product on every shelf, Amazon's included. An oversold shelf
// holds none, and can't cancel stock on another.
export async function heldOf(db: Db, productId: number) {
	const [row] = await db
		.select({
			held: sql<number>`coalesce(sum(greatest(${stockLevels.onHand}, 0)), 0)::int`,
		})
		.from(stockLevels)
		.where(eq(stockLevels.productId, productId));
	return row.held;
}

// Locks products in id order, so two postings can't deadlock, and returns
// each one's cost and kind.
async function lockProducts(db: Db, productIds: number[]) {
	const ids = [...new Set(productIds)].sort((a, b) => a - b);
	const rows = await db
		.select({
			id: products.id,
			kind: products.kind,
			unitCost: products.unitCost,
		})
		.from(products)
		.where(inArray(products.id, ids))
		.orderBy(products.id)
		.for("update");
	return new Map(rows.map((r) => [r.id, r]));
}

type Entry = {
	productId: number;
	kind: Kind;
	units: number;
	heldBefore: number;
	avgBefore: number | null;
	applied: Applied;
	batchId?: string | null;
	purchaseOrderLineId?: number | null;
	note?: string | null;
	// Dates the cost now even if it didn't change: a receipt confirms it.
	dated?: boolean;
	setAt?: Date | ReturnType<typeof sql> | null;
};

// The entry first, then the product, so the trigger sees the entry and
// doesn't add its own. The trigger also gives a product's first cost to the
// sales that went out without one (drizzle/0114).
async function record(db: Db, e: Entry) {
	await db.insert(costEntries).values({
		productId: e.productId,
		kind: e.kind,
		units: e.units,
		value: e.applied.value,
		heldBefore: e.heldBefore,
		avgBefore: e.avgBefore,
		avgAfter: e.applied.avgAfter,
		soldValue: e.applied.soldValue,
		batchId: e.batchId ?? null,
		purchaseOrderLineId: e.purchaseOrderLineId ?? null,
		note: e.note ?? null,
	});
	const changed = e.applied.avgAfter !== e.avgBefore;
	if (changed || e.dated || e.setAt)
		await db
			.update(products)
			.set({
				unitCost: e.applied.avgAfter,
				...(e.setAt
					? { unitCostUpdatedAt: e.setAt }
					: e.dated
						? { unitCostUpdatedAt: sql`now()` }
						: {}),
			})
			.where(eq(products.id, e.productId));
}

// The value moving with a ledger batch, posted before its movements so each
// product's held stock is what it was before them.
export async function postBatchCosts(
	db: Db,
	lines: CostLine[],
	batchId: string,
) {
	if (lines.length === 0) return;
	const locked = await lockProducts(
		db,
		lines.map((l) => l.productId),
	);
	const state = new Map<number, { held: number; avg: number | null }>();
	for (const line of lines) {
		const product = locked.get(line.productId);
		if (!product) throw new Error(`Unknown product ${line.productId}`);
		const now = state.get(line.productId) ?? {
			held: await heldOf(db, line.productId),
			avg: product.unitCost,
		};
		const applied = applyCost(now.held, now.avg, line);
		await record(db, {
			...line,
			heldBefore: now.held,
			avgBefore: now.avg,
			applied,
			batchId,
			dated: line.kind === "receipt",
		});
		state.set(line.productId, {
			held: Math.max(0, now.held) + line.units,
			avg: applied.avgAfter,
		});
	}
}

// Items that arrived in a batch already posted, at `value` (null: at the
// average), for when the value is only known once the batch is in: a PO
// receipt's discounts hang off its receipt row. Kept with the batch, so
// undoing it takes the value back out.
export async function postArrival(
	db: Db,
	input: {
		productId: number;
		units: number;
		value: number | null;
		batchId: string;
		purchaseOrderLineId?: number | null;
		note?: string;
	},
) {
	const product = (await lockProducts(db, [input.productId])).get(
		input.productId,
	);
	if (!product) throw new Error(`Unknown product ${input.productId}`);
	// The batch put its units on a shelf that restarted from 0 if it was
	// oversold, so taking them off again leaves what was held before.
	const held = (await heldOf(db, input.productId)) - input.units;
	const applied = applyCost(held, product.unitCost, input);
	await record(db, {
		...input,
		kind: "receipt",
		heldBefore: held,
		avgBefore: product.unitCost,
		applied,
		dated: true,
	});
	return applied;
}

// Value that changes with no stock moving: a corrected price, freight that
// came later. `share` of it is on the shelf; the rest is on what's sold.
export async function postValue(
	db: Db,
	input: {
		productId: number;
		kind: Extract<Kind, "po_correction">;
		value: number;
		share: number;
		perItem: number | null;
		purchaseOrderLineId?: number | null;
		note?: string;
	},
) {
	const product = (await lockProducts(db, [input.productId])).get(
		input.productId,
	);
	if (!product) throw new Error(`Unknown product ${input.productId}`);
	const held = await heldOf(db, input.productId);
	const applied = applyCost(held, product.unitCost, { units: 0, ...input });
	await record(db, {
		...input,
		units: 0,
		heldBefore: held,
		avgBefore: product.unitCost,
		applied,
	});
	return applied;
}

// Sets the average by hand. What's on the shelf is revalued to it; sales
// already made keep their cost. Null makes it unknown.
export async function setCost(
	db: Db,
	input: {
		productId: number;
		cost: number | null;
		note?: string;
		setAt?: Date | null;
	},
) {
	const product = (await lockProducts(db, [input.productId])).get(
		input.productId,
	);
	if (!product) throw new Error(`Unknown product ${input.productId}`);
	const held = await heldOf(db, input.productId);
	const cost = input.cost === null ? null : r4(input.cost);
	await record(db, {
		productId: input.productId,
		kind: "set",
		units: 0,
		heldBefore: held,
		avgBefore: product.unitCost,
		applied: {
			value:
				cost === null || product.unitCost === null
					? null
					: r4((cost - product.unitCost) * held),
			avgAfter: cost,
			soldValue: 0,
		},
		note: input.note,
		setAt: input.setAt ?? sql`now()`,
	});
}

// The entries an undone batch reverses: the same units and value, back out.
export async function reversalOf(db: Db, batchId: string): Promise<CostLine[]> {
	const rows = await db
		.select()
		.from(costEntries)
		.where(eq(costEntries.batchId, batchId))
		.orderBy(costEntries.id);
	return rows.map((r) => ({
		productId: r.productId,
		kind: "undo",
		units: -r.units,
		value: r.value === null ? null : -r.value,
		purchaseOrderLineId: r.purchaseOrderLineId,
		note: `Undo: ${r.kind}`,
	}));
}
