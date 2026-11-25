import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { committedStock } from "#/db/quantity-schema";
import { movements, stockLevels } from "#/db/schema";
import type { CostLine } from "#/inventory/valuation";
import { lockedWholeSet, wholeSetOf } from "#/inventory/whole-sets";
import {
	asStocked,
	assertPositiveInteger,
	getProduct,
	LedgerError,
	lockRecipe,
	postMovements,
} from "./post";

// A second shelf a sale may take from, and how many it holds back.
export type Overflow = { locationId: number; keep: number };

// A bundle sale takes its whole sets first (src/inventory/whole-sets.ts), as
// many as the shelves it sells from hold, then stock from each component.
// Simple and kit sales take
// stock from the SKU itself. With an `overflow` (the retail store, for a
// shipped order), units `locationId` doesn't hold come off that shelf
// instead, as far as it holds more than it keeps; what neither can give is
// oversold at `locationId`.
export async function recordSale(
	db: Db,
	input: {
		productId: number;
		quantity: number;
		locationId: number;
		overflow?: Overflow | null;
		reference: string;
	},
) {
	const overflow =
		input.overflow && input.overflow.locationId !== input.locationId
			? input.overflow
			: null;
	if (!overflow)
		return postUnits(db, {
			...input,
			sign: -1,
			reason: "sale",
			from: { locationId: input.locationId, overflow: null },
		});
	const overflowId = overflow.locationId;
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const units = await unitsOf(tx, input.productId, input.quantity, {
			locationId: input.locationId,
			overflow,
		});
		// Locked in the order postMovements updates them, so a sale landing at
		// the same time waits rather than both taking the same units.
		const levels = await tx
			.select()
			.from(stockLevels)
			.where(
				and(
					inArray(
						stockLevels.productId,
						units.map((u) => u.productId),
					),
					inArray(stockLevels.locationId, [input.locationId, overflowId]),
				),
			)
			.orderBy(stockLevels.productId, stockLevels.locationId)
			.for("update");
		const holds = (productId: number, locationId: number) =>
			Math.max(
				0,
				levels.find(
					(l) => l.productId === productId && l.locationId === locationId,
				)?.onHand ?? 0,
			);
		return postMovements(tx, {
			reference: input.reference,
			lines: units.flatMap((u) => {
				const first = Math.min(
					u.quantity,
					holds(u.productId, input.locationId),
				);
				const spill = Math.min(
					u.quantity - first,
					Math.max(0, holds(u.productId, overflowId) - overflow.keep),
				);
				const main = u.quantity - spill;
				return [
					...(main > 0
						? [
								{
									productId: u.productId,
									locationId: input.locationId,
									delta: -main,
									reason: "sale" as const,
								},
							]
						: []),
					...(spill > 0
						? [
								{
									productId: u.productId,
									locationId: overflowId,
									delta: -spill,
									reason: "sale" as const,
								},
							]
						: []),
				];
			}),
		});
	});
}

// The stocked units behind `quantity` of a product: the product itself, or
// for a bundle its components. A bundle sold `from` shelves takes the whole
// sets they hold first, and components only for the rest.
async function unitsOf(
	db: Db,
	productId: number,
	quantity: number,
	from: { locationId: number; overflow: Overflow | null } | null,
) {
	const whole = await wholeSetOf(db, productId);
	const { parent: sku, recipe } = await lockRecipe(
		db,
		productId,
		whole === null ? [] : [whole],
	);
	if (sku.kind !== "bundle") return [{ productId: sku.id, quantity }];
	await lockedWholeSet(db, productId, whole);
	const boxes =
		whole !== null && from
			? Math.min(quantity, await held(db, whole, from))
			: 0;
	const loose = quantity - boxes;
	if (loose > 0 && recipe.length === 0)
		throw new LedgerError(`Bundle ${sku.sku} has no components`);
	return [
		...(whole !== null && boxes > 0
			? [{ productId: whole, quantity: boxes }]
			: []),
		...(loose > 0
			? recipe.map((c) => ({
					productId: c.productId,
					quantity: c.quantity * loose,
				}))
			: []),
	];
}

// How many of a product a sale `from` these shelves can take: what the shelf
// holds, and what the overflow holds above what it keeps. Locks the rows; the
// caller holds the product locked, so no other sale reads them meanwhile.
async function held(
	db: Db,
	productId: number,
	from: { locationId: number; overflow: Overflow | null },
) {
	const rows = await db
		.select()
		.from(stockLevels)
		.where(
			and(
				eq(stockLevels.productId, productId),
				inArray(stockLevels.locationId, [
					from.locationId,
					...(from.overflow ? [from.overflow.locationId] : []),
				]),
			),
		)
		.orderBy(stockLevels.locationId)
		.for("update");
	const at = (locationId: number) =>
		rows.find((r) => r.locationId === locationId)?.onHand ?? 0;
	// A counter sale, once stock is committed, leaves what orders reserved.
	const [promised] = await db
		.select({ units: committedStock.units })
		.from(committedStock)
		.where(eq(committedStock.productId, productId));
	return Math.max(
		0,
		Math.max(0, at(from.locationId)) +
			(from.overflow
				? Math.max(0, at(from.overflow.locationId) - from.overflow.keep)
				: 0) -
			(promised?.units ?? 0),
	);
}

// A returned unit goes back on the shelf the way it was sold: a bundle as
// its components, anything else as itself. `unitCost` is what one cost the
// sale, which it brings back into the average (a refurb's too); a tool set's
// parts come back at their averages.
export async function recordReturn(
	db: Db,
	input: {
		productId: number;
		quantity: number;
		locationId: number;
		reference: string;
		// The sale it comes back from: its batch, or every batch when it went
		// out in several shipments, and how many units those sold.
		sale: { batchId: string; batchIds?: string[]; quantity: number } | null;
		unitCost?: number | null;
	},
) {
	assertPositiveInteger(input.quantity);
	const product = await getProduct(db, input.productId);
	const costs: CostLine[] =
		product.kind === "bundle" || input.unitCost == null
			? []
			: [
					{
						productId: input.productId,
						kind: "return",
						units: input.quantity,
						value: input.quantity * input.unitCost,
					},
				];
	const sale = input.sale;
	if (sale) {
		assertPositiveInteger(sale.quantity);
		const sold = await db
			.select()
			.from(movements)
			.where(inArray(movements.batchId, sale.batchIds ?? [sale.batchId]));
		if (
			sold.length === 0 ||
			sold.some((line) => line.reason !== "sale" || line.delta >= 0)
		) {
			throw new LedgerError("The original sale movements are unavailable");
		}
		// A sale that took from two shelves comes back to one.
		const perProduct = new Map<number, number>();
		for (const line of sold)
			perProduct.set(
				line.productId,
				(perProduct.get(line.productId) ?? 0) - line.delta,
			);
		const whole =
			product.kind === "bundle" ? await wholeSetOf(db, product.id) : null;
		const back = comingBack(
			perProduct,
			whole,
			sale.quantity,
			input.quantity,
			whole === null ? 0 : await alreadyBack(db, whole, input.reference),
		);
		// Sold before it became a tool set, it comes back as its parts.
		return db.transaction(async (tx) =>
			postMovements(tx, {
				reference: input.reference,
				...(await asStocked(
					tx,
					[...back].map(([productId, delta]) => ({
						productId,
						locationId: input.locationId,
						delta,
						reason: "return" as const,
					})),
					costs.filter((c) => perProduct.has(c.productId)),
				)),
			}),
		);
	}
	if (product.kind === "bundle") {
		throw new LedgerError(
			"This bundle has no recorded sale components; count the returned parts individually",
		);
	}
	return postUnits(db, { ...input, sign: 1, reason: "return", costs });
}

// How many of a product earlier returns under this reference (one order
// line's) brought back and still stand.
async function alreadyBack(db: Db, productId: number, reference: string) {
	const rows = await db
		.select({ batchId: movements.batchId, delta: movements.delta })
		.from(movements)
		.where(
			and(
				eq(movements.productId, productId),
				eq(movements.reference, reference),
				eq(movements.reason, "return"),
			),
		);
	if (rows.length === 0) return 0;
	const undone = await db
		.select({ reference: movements.reference })
		.from(movements)
		.where(
			inArray(
				movements.reference,
				rows.map((r) => `undo:${r.batchId}`),
			),
		);
	const gone = new Set(undone.map((u) => u.reference));
	return rows
		.filter((r) => !gone.has(`undo:${r.batchId}`))
		.reduce((n, r) => n + r.delta, 0);
}

// What `returned` of the `sold` units a sale took bring back, per product:
// the same share of each. A tool set sold partly as whole sets and partly
// as parts has no even share, so its whole sets come back first, as many
// as went out and aren't `back` already, then parts for the rest.
function comingBack(
	took: Map<number, number>,
	whole: number | null,
	sold: number,
	returned: number,
	back: number,
) {
	const boxes = whole === null ? 0 : (took.get(whole) ?? 0);
	if (boxes === 0 || boxes >= sold)
		return new Map(
			[...took].map(([id, units]) => [id, (units * returned) / sold]),
		);
	const wholeBack = Math.min(returned, Math.max(0, boxes - back));
	const looseBack = returned - wholeBack;
	return new Map(
		[...took].flatMap(([id, units]): [number, number][] => {
			const delta =
				id === whole ? wholeBack : (units * looseBack) / (sold - boxes);
			return delta === 0 ? [] : [[id, delta]];
		}),
	);
}

async function postUnits(
	db: Db,
	input: {
		productId: number;
		quantity: number;
		locationId: number;
		reference: string;
		sign: 1 | -1;
		reason: "sale" | "return";
		costs?: CostLine[];
		// The shelves a sale takes whole sets from.
		from?: { locationId: number; overflow: null };
	},
) {
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const units = await unitsOf(
			tx,
			input.productId,
			input.quantity,
			input.from ?? null,
		);
		return postMovements(tx, {
			reference: input.reference,
			costs: input.costs,
			lines: units.map((u) => ({
				productId: u.productId,
				locationId: input.locationId,
				delta: input.sign * u.quantity,
				reason: input.reason,
			})),
		});
	});
}
