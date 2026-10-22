import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	movements,
	productComponents,
	products,
	stockLevels,
} from "#/db/schema";

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
// one transaction, so the two can't drift apart.
export async function postMovements(
	db: Db,
	input: { lines: MovementLine[]; reference?: string; note?: string },
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
		const productIds = [...new Set(lines.map((l) => l.productId))];
		const bundles = await tx
			.select({ sku: products.sku })
			.from(products)
			.where(
				and(inArray(products.id, productIds), eq(products.kind, "bundle")),
			);
		if (bundles.length > 0) {
			throw new LedgerError(
				`Bundles have no stock of their own: ${bundles.map((b) => b.sku).join(", ")}`,
			);
		}

		const batchId = crypto.randomUUID();
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
