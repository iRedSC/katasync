import { randomUUID } from "node:crypto";
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
		if (!Number.isInteger(line.delta) || line.delta === 0) {
			throw new LedgerError(
				`Delta must be a nonzero integer, got ${line.delta}`,
			);
		}
		const key = `${line.productId}:${line.locationId}`;
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

		const batchId = randomUUID();
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

async function getRecipe(db: Db, parentProductId: number) {
	return db
		.select({
			productId: productComponents.componentProductId,
			quantity: productComponents.quantity,
		})
		.from(productComponents)
		.where(eq(productComponents.parentProductId, parentProductId));
}

async function getProduct(db: Db, productId: number) {
	const [sku] = await db
		.select()
		.from(products)
		.where(eq(products.id, productId));
	if (!sku) throw new LedgerError(`Unknown product ${productId}`);
	return sku;
}

// A bundle sale takes stock from each component. Simple and kit sales take
// stock from the SKU itself.
export async function recordSale(
	db: Db,
	input: {
		productId: number;
		quantity: number;
		locationId: number;
		reference: string;
	},
) {
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const sku = await getProduct(tx, input.productId);
		const taken =
			sku.kind === "bundle"
				? (await getRecipe(tx, sku.id)).map((c) => ({
						productId: c.productId,
						quantity: c.quantity * input.quantity,
					}))
				: [{ productId: sku.id, quantity: input.quantity }];
		if (taken.length === 0)
			throw new LedgerError(`Bundle ${sku.sku} has no components`);

		return postMovements(tx, {
			reference: input.reference,
			lines: taken.map((t) => ({
				productId: t.productId,
				locationId: input.locationId,
				delta: -t.quantity,
				reason: "sale" as const,
			})),
		});
	});
}

// Builds kits from components at one location. Fails without changing anything
// if any component would go below zero, since you can't build from parts you
// don't have.
export async function assembleKits(
	db: Db,
	input: {
		kitProductId: number;
		quantity: number;
		locationId: number;
		reference?: string;
	},
) {
	return convertKits(db, input, "assemble");
}

// Breaks kits back into components, e.g. to free a part for a bundle order.
export async function disassembleKits(
	db: Db,
	input: {
		kitProductId: number;
		quantity: number;
		locationId: number;
		reference?: string;
	},
) {
	return convertKits(db, input, "disassemble");
}

async function convertKits(
	db: Db,
	input: {
		kitProductId: number;
		quantity: number;
		locationId: number;
		reference?: string;
	},
	direction: "assemble" | "disassemble",
) {
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const kit = await getProduct(tx, input.kitProductId);
		if (kit.kind !== "kit") throw new LedgerError(`${kit.sku} is not a kit`);
		const recipe = await getRecipe(tx, kit.id);
		if (recipe.length === 0)
			throw new LedgerError(`Kit ${kit.sku} has no components`);

		const sign = direction === "assemble" ? 1 : -1;
		const result = await postMovements(tx, {
			reference: input.reference,
			lines: [
				{
					productId: kit.id,
					locationId: input.locationId,
					delta: sign * input.quantity,
					reason:
						direction === "assemble" ? "assembly_produce" : "assembly_consume",
				},
				...recipe.map((c) => ({
					productId: c.productId,
					locationId: input.locationId,
					delta: -sign * c.quantity * input.quantity,
					reason:
						direction === "assemble"
							? ("assembly_consume" as const)
							: ("assembly_produce" as const),
				})),
			],
		});

		// Only what this operation consumed can be short. A kit that was already
		// oversold shouldn't block building more of it.
		const consumed = new Set(
			direction === "assemble" ? recipe.map((c) => c.productId) : [kit.id],
		);
		const short = result.levels.filter(
			(l) => consumed.has(l.productId) && l.onHand < 0,
		);
		if (short.length > 0) {
			const shortProducts = await tx
				.select({ sku: products.sku })
				.from(products)
				.where(
					inArray(
						products.id,
						short.map((l) => l.productId),
					),
				);
			throw new LedgerError(
				`Not enough stock to ${direction} ${input.quantity} × ${kit.sku}: ${shortProducts.map((s) => s.sku).join(", ")}`,
			);
		}
		return result;
	});
}

function assertPositiveInteger(quantity: number) {
	if (!Number.isInteger(quantity) || quantity <= 0) {
		throw new LedgerError(
			`Quantity must be a positive integer, got ${quantity}`,
		);
	}
}

// Records what someone counted on the shelf as a correction for the
// difference. Returns the change, which is 0 (and records nothing) when the
// count matches. Runs in one transaction with the row locked, so a sale landing
// mid-count can't be overwritten.
export async function recordCount(
	db: Db,
	input: {
		productId: number;
		locationId: number;
		counted: number;
		note: string;
	},
): Promise<{ delta: number; onHand: number; batchId: string | null }> {
	if (!Number.isInteger(input.counted)) {
		throw new LedgerError(`Count must be a whole number, got ${input.counted}`);
	}
	return db.transaction(async (tx) => {
		const product = await getProduct(tx, input.productId);
		if (product.kind === "bundle") {
			throw new LedgerError(
				"Tool sets have no stock of their own; count their parts",
			);
		}
		// Lock the row (creating it if needed) before reading it.
		await tx
			.insert(stockLevels)
			.values({
				productId: input.productId,
				locationId: input.locationId,
				onHand: 0,
			})
			.onConflictDoNothing();
		const [level] = await tx
			.select({ onHand: stockLevels.onHand })
			.from(stockLevels)
			.where(
				and(
					eq(stockLevels.productId, input.productId),
					eq(stockLevels.locationId, input.locationId),
				),
			)
			.for("update");
		const delta = input.counted - level.onHand;
		if (delta === 0) return { delta, onHand: level.onHand, batchId: null };
		const result = await postMovements(tx, {
			note: input.note,
			lines: [
				{
					productId: input.productId,
					locationId: input.locationId,
					delta,
					reason: "adjustment",
				},
			],
		});
		return {
			delta,
			onHand: result.levels[0].onHand,
			batchId: result.batchId,
		};
	});
}

// Reverses an earlier operation by posting its exact opposite, since movements
// are never edited. Each batch can be undone once.
export async function undoBatch(db: Db, batchId: string) {
	return db.transaction(async (tx) => {
		const original = await tx
			.select()
			.from(movements)
			.where(eq(movements.batchId, batchId));
		if (original.length === 0) throw new LedgerError("Nothing to undo");
		const reference = `undo:${batchId}`;
		const [already] = await tx
			.select({ id: movements.id })
			.from(movements)
			.where(eq(movements.reference, reference))
			.limit(1);
		if (already) throw new LedgerError("Already undone");
		return postMovements(tx, {
			reference,
			note: original[0].note ? `Undo: ${original[0].note}` : "Undo",
			lines: original.map((m) => ({
				productId: m.productId,
				locationId: m.locationId,
				delta: -m.delta,
				reason: m.reason,
			})),
		});
	});
}
