import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { movements, stockLevels } from "#/db/schema";
import {
	assertPositiveInteger,
	getProduct,
	getRecipe,
	LedgerError,
	postMovements,
} from "./post";

// A second shelf a sale may take from, and how many it holds back.
export type Overflow = { locationId: number; keep: number };

// A bundle sale takes stock from each component. Simple and kit sales take
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
	const { overflow } = input;
	if (!overflow || overflow.locationId === input.locationId)
		return postUnits(db, { ...input, sign: -1, reason: "sale" });
	const overflowId = overflow.locationId;
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const units = await unitsOf(tx, input.productId, input.quantity);
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

// The stocked units behind `quantity` of a product: a bundle's components,
// or the product itself.
async function unitsOf(db: Db, productId: number, quantity: number) {
	const sku = await getProduct(db, productId);
	if (sku.kind !== "bundle") return [{ productId: sku.id, quantity }];
	const units = (await getRecipe(db, sku.id)).map((c) => ({
		productId: c.productId,
		quantity: c.quantity * quantity,
	}));
	if (units.length === 0)
		throw new LedgerError(`Bundle ${sku.sku} has no components`);
	return units;
}

// A returned unit goes back on the shelf the way it was sold: a bundle as
// its components, anything else as itself.
export async function recordReturn(
	db: Db,
	input: {
		productId: number;
		quantity: number;
		locationId: number;
		reference: string;
		sale: { batchId: string; quantity: number } | null;
	},
) {
	assertPositiveInteger(input.quantity);
	const sale = input.sale;
	if (sale) {
		assertPositiveInteger(sale.quantity);
		const sold = await db
			.select()
			.from(movements)
			.where(eq(movements.batchId, sale.batchId));
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
		return postMovements(db, {
			reference: input.reference,
			lines: [...perProduct].map(([productId, units]) => ({
				productId,
				locationId: input.locationId,
				delta: (units * input.quantity) / sale.quantity,
				reason: "return",
			})),
		});
	}
	const product = await getProduct(db, input.productId);
	if (product.kind === "bundle") {
		throw new LedgerError(
			"This bundle has no recorded sale components; count the returned parts individually",
		);
	}
	return postUnits(db, { ...input, sign: 1, reason: "return" });
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
	},
) {
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const units = await unitsOf(tx, input.productId, input.quantity);
		return postMovements(tx, {
			reference: input.reference,
			lines: units.map((u) => ({
				productId: u.productId,
				locationId: input.locationId,
				delta: input.sign * u.quantity,
				reason: input.reason,
			})),
		});
	});
}
