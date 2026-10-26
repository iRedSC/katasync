import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productBulkPrices, productSuppliers } from "#/db/schema";
import { setOfferTerms } from "#/purchasing/catalogs";
import { PurchaseOrderError } from "#/purchasing/orders";
import { breaksProblem, convertBreaks, type PriceBreak } from "./bulk";

// Reading and saving suppliers' bulk prices (rules in ./bulk.ts).

// Every bulk price for the products, by supplier, fewest units first. Only
// those in the supplier's current pack size exist (the table's key).
export async function bulkPricesOf(db: Db, productIds: number[]) {
	if (productIds.length === 0) return [];
	return db
		.select({
			productId: productBulkPrices.productId,
			supplierId: productBulkPrices.supplierId,
			minQuantity: productBulkPrices.minQuantity,
			cost: productBulkPrices.cost,
		})
		.from(productBulkPrices)
		.where(inArray(productBulkPrices.productId, productIds))
		.orderBy(asc(productBulkPrices.minQuantity));
}

// Groups bulkPricesOf by product and supplier, keyed `${productId}:${supplierId}`.
export function breaksByOffer(rows: Awaited<ReturnType<typeof bulkPricesOf>>) {
	const out = new Map<string, PriceBreak[]>();
	for (const r of rows) {
		const key = `${r.productId}:${r.supplierId}`;
		out.set(key, [
			...(out.get(key) ?? []),
			{ minQuantity: r.minQuantity, cost: r.cost },
		]);
	}
	return out;
}

// Replaces a supplier's bulk prices for a product, in its unit now; none
// removes them. Refused, saying why, when they'd never apply or cost more
// than ordering fewer. Returns the ones it had, so they can be put back.
// Draft lines already on the PO keep their price until their quantity
// changes.
export async function setBulkPrices(
	db: Db,
	input: { productId: number; supplierId: number; breaks: PriceBreak[] },
): Promise<PriceBreak[]> {
	return db.transaction(async (tx) => {
		// Checks the supplier sells it, and makes its terms row if it has none.
		await setOfferTerms(tx, input.productId, input.supplierId, {});
		await tx
			.insert(productSuppliers)
			.values({
				productId: input.productId,
				supplierId: input.supplierId,
				supplierCount: 1,
			})
			.onConflictDoNothing();
		const [terms] = await tx
			.select({
				packSize: productSuppliers.packSize,
				cost: productSuppliers.cost,
				minimumQuantity: productSuppliers.minimumQuantity,
			})
			.from(productSuppliers)
			.where(offer(input))
			.for("update");
		const problem = breaksProblem(
			terms.cost,
			terms.minimumQuantity,
			input.breaks,
		);
		if (problem) throw new PurchaseOrderError(problem);
		const was = await tx
			.delete(productBulkPrices)
			.where(
				and(
					eq(productBulkPrices.productId, input.productId),
					eq(productBulkPrices.supplierId, input.supplierId),
				),
			)
			.returning({
				minQuantity: productBulkPrices.minQuantity,
				cost: productBulkPrices.cost,
			});
		if (input.breaks.length > 0)
			await tx.insert(productBulkPrices).values(
				input.breaks.map((b) => ({
					productId: input.productId,
					supplierId: input.supplierId,
					packSize: terms.packSize,
					minQuantity: b.minQuantity,
					cost: b.cost,
				})),
			);
		return was.sort((a, b) => a.minQuantity - b.minQuantity);
	});
}

// Takes a supplier's bulk prices off before its pack size changes, and
// returns a function putting them back converted to the new size once it
// has. Called with the terms row locked (setDefaultTerms).
export async function holdBulkPrices(
	tx: Db,
	productId: number,
	supplierId: number,
	fromPack: number,
) {
	const held = await tx
		.delete(productBulkPrices)
		.where(
			and(
				eq(productBulkPrices.productId, productId),
				eq(productBulkPrices.supplierId, supplierId),
			),
		)
		.returning({
			minQuantity: productBulkPrices.minQuantity,
			cost: productBulkPrices.cost,
		});
	return async (toPack: number, minimumQuantity: number) => {
		const breaks = convertBreaks(held, fromPack, toPack, minimumQuantity);
		if (breaks.length > 0)
			await tx.insert(productBulkPrices).values(
				breaks.map((b) => ({
					productId,
					supplierId,
					packSize: toPack,
					...b,
				})),
			);
	};
}

const offer = (p: { productId: number; supplierId: number }) =>
	and(
		eq(productSuppliers.productId, p.productId),
		eq(productSuppliers.supplierId, p.supplierId),
	);
