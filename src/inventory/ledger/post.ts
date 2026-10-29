import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	costEntries,
	movements,
	productComponents,
	products,
	stockLevels,
} from "#/db/schema";
import { type CostLine, postBatchCosts } from "#/inventory/valuation";

export class LedgerError extends Error {
	name = "LedgerError";
}

type MovementReason = (typeof movements.$inferInsert)["reason"];

export type MovementLine = {
	productId: number;
	locationId: number;
	delta: number;
	reason: MovementReason;
};

export type StockLevel = {
	productId: number;
	locationId: number;
	onHand: number;
};

// The only way stock changes. Inserts the movements and updates stock_levels in
// one transaction, so the two can't drift apart. `costs` is the value that
// moves with them where it isn't the average (src/inventory/valuation.ts),
// kept with the batch so undoing it takes that value back out.
export async function postMovements(
	db: Db,
	input: {
		lines: MovementLine[];
		reference?: string;
		note?: string;
		costs?: CostLine[];
	},
): Promise<{ batchId: string; levels: StockLevel[] }> {
	const { lines } = input;
	if (lines.length === 0) throw new LedgerError("No movement lines");

	const seen = new Set<string>();
	for (const line of lines) {
		// An opening balance of 0 is a record that the shelf was empty.
		if (
			!Number.isInteger(line.delta) ||
			(line.delta === 0 && line.reason !== "opening_balance")
		) {
			throw new LedgerError(
				`Delta must be a nonzero integer, got ${line.delta}`,
			);
		}
		// Twice for one reason is a mistake; a receipt can also write off
		// oversold stock on the same shelf (see postReceipt).
		const key = `${line.productId}:${line.locationId}:${line.reason}`;
		if (seen.has(key)) {
			throw new LedgerError(
				`Product ${line.productId} appears twice at location ${line.locationId}`,
			);
		}
		seen.add(key);
	}

	return db.transaction(async (tx) => {
		const productIds = [
			...new Set([
				...lines.map((line) => line.productId),
				...(input.costs ?? []).map((cost) => cost.productId),
			]),
		];
		const locked = await lockStockProducts(tx, productIds);
		const bundles = locked.filter((product) => product.kind === "bundle");
		if (bundles.length > 0) {
			throw new LedgerError(
				`Bundles have no stock of their own: ${bundles.map((b) => b.sku).join(", ")}`,
			);
		}

		const batchId = crypto.randomUUID();
		await postBatchCosts(tx, input.costs ?? [], batchId);
		await tx.insert(movements).values(
			lines.map((line) => ({
				...line,
				batchId,
				reference: input.reference,
				note: input.note,
			})),
		);

		// Update rows in a fixed order so concurrent batches lock them in the same
		// order and can't deadlock. The upsert locks each row until commit.
		const ordered = [...lines].sort(
			(a, b) => a.productId - b.productId || a.locationId - b.locationId,
		);
		const levels: StockLevel[] = [];
		for (const line of ordered) {
			const [level] = await tx
				.insert(stockLevels)
				.values({
					productId: line.productId,
					locationId: line.locationId,
					onHand: line.delta,
				})
				.onConflictDoUpdate({
					target: [stockLevels.productId, stockLevels.locationId],
					set: { onHand: sql`${stockLevels.onHand} + ${line.delta}` },
				})
				.returning();
			levels.push(level);
		}
		return { batchId, levels };
	});
}

export async function lockStockProducts(db: Db, productIds: number[]) {
	const ids = [...new Set(productIds)].sort((left, right) => left - right);
	if (ids.length === 0) return [];
	const rows = await db
		.select()
		.from(products)
		.where(inArray(products.id, ids))
		.orderBy(products.id)
		.for("update");
	if (rows.length !== ids.length)
		throw new LedgerError("Unknown stock product");
	return rows;
}

export async function batchProductIds(db: Db, batchIds: string[]) {
	if (batchIds.length === 0) return [];
	const entries = await db
		.select({ productId: movements.productId })
		.from(movements)
		.where(inArray(movements.batchId, batchIds))
		.union(
			db
				.select({ productId: costEntries.productId })
				.from(costEntries)
				.where(inArray(costEntries.batchId, batchIds)),
		);
	return entries.map((entry) => entry.productId);
}

export async function lockBatchProducts(
	db: Db,
	batchIds: string[],
	additionalProductIds: number[] = [],
) {
	return lockStockProducts(db, [
		...(await batchProductIds(db, batchIds)),
		...additionalProductIds,
	]);
}

export async function lockRecipe(
	db: Db,
	parentProductId: number,
	additionalProductIds: number[] = [],
) {
	const { recipes, products: locked } = await lockRecipes(
		db,
		[parentProductId],
		additionalProductIds,
	);
	const parent = locked.find((product) => product.id === parentProductId);
	if (!parent) throw new LedgerError(`Unknown product ${parentProductId}`);
	return {
		parent,
		recipe: recipes.get(parentProductId) ?? [],
		products: locked,
	};
}

export async function lockRecipes(
	db: Db,
	parentProductIds: number[],
	additionalProductIds: number[] = [],
) {
	const ids = [...new Set(parentProductIds)].sort(
		(left, right) => left - right,
	);
	const before = await recipesOf(db, ids);
	const locked = await lockStockProducts(db, [
		...ids,
		...before.map((part) => part.productId),
		...additionalProductIds,
	]);
	// A recipe that changed while this waited is fine as long as every part it
	// names is locked: the parents are locked now, so it can't change again.
	const current = await recipesOf(db, ids);
	const lockedIds = new Set(locked.map((product) => product.id));
	if (current.some((part) => !lockedIds.has(part.productId)))
		throw new LedgerError("The recipe changed; try again");
	const recipes = new Map<number, { productId: number; quantity: number }[]>();
	for (const part of current) {
		const parts = recipes.get(part.parentProductId) ?? [];
		parts.push({ productId: part.productId, quantity: part.quantity });
		recipes.set(part.parentProductId, parts);
	}
	return { products: locked, recipes };
}

async function recipesOf(db: Db, parentProductIds: number[]) {
	if (parentProductIds.length === 0) return [];
	return db
		.select({
			parentProductId: productComponents.parentProductId,
			productId: productComponents.componentProductId,
			quantity: productComponents.quantity,
		})
		.from(productComponents)
		.where(inArray(productComponents.parentProductId, parentProductIds))
		.orderBy(
			productComponents.parentProductId,
			productComponents.componentProductId,
		);
}

export async function getRecipe(db: Db, parentProductId: number) {
	return db
		.select({
			productId: productComponents.componentProductId,
			quantity: productComponents.quantity,
		})
		.from(productComponents)
		.where(eq(productComponents.parentProductId, parentProductId));
}

export async function getProduct(db: Db, productId: number) {
	const [sku] = await db
		.select()
		.from(products)
		.where(eq(products.id, productId));
	if (!sku) throw new LedgerError(`Unknown product ${productId}`);
	return sku;
}

export function assertPositiveInteger(quantity: number) {
	if (!Number.isInteger(quantity) || quantity <= 0) {
		throw new LedgerError(
			`Quantity must be a positive integer, got ${quantity}`,
		);
	}
}
