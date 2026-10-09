import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { movements, skuComponents, skus, stockLevels } from "#/db/schema";

export class LedgerError extends Error {
	name = "LedgerError";
}

type MovementReason = (typeof movements.$inferInsert)["reason"];

export type MovementLine = {
	skuId: number;
	locationId: number;
	delta: number;
	reason: MovementReason;
};

export type StockLevel = { skuId: number; locationId: number; onHand: number };

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
		const key = `${line.skuId}:${line.locationId}`;
		if (seen.has(key)) {
			throw new LedgerError(
				`SKU ${line.skuId} appears twice at location ${line.locationId}`,
			);
		}
		seen.add(key);
	}

	return db.transaction(async (tx) => {
		const skuIds = [...new Set(lines.map((l) => l.skuId))];
		const bundles = await tx
			.select({ sku: skus.sku })
			.from(skus)
			.where(and(inArray(skus.id, skuIds), eq(skus.kind, "bundle")));
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
			(a, b) => a.skuId - b.skuId || a.locationId - b.locationId,
		);
		const levels: StockLevel[] = [];
		for (const line of ordered) {
			const [level] = await tx
				.insert(stockLevels)
				.values({
					skuId: line.skuId,
					locationId: line.locationId,
					onHand: line.delta,
				})
				.onConflictDoUpdate({
					target: [stockLevels.skuId, stockLevels.locationId],
					set: { onHand: sql`${stockLevels.onHand} + ${line.delta}` },
				})
				.returning();
			levels.push(level);
		}
		return { batchId, levels };
	});
}

async function getRecipe(db: Db, parentSkuId: number) {
	return db
		.select({
			skuId: skuComponents.componentSkuId,
			quantity: skuComponents.quantity,
		})
		.from(skuComponents)
		.where(eq(skuComponents.parentSkuId, parentSkuId));
}

async function getSku(db: Db, skuId: number) {
	const [sku] = await db.select().from(skus).where(eq(skus.id, skuId));
	if (!sku) throw new LedgerError(`Unknown SKU ${skuId}`);
	return sku;
}

// A bundle sale takes stock from each component. Simple and kit sales take
// stock from the SKU itself.
export async function recordSale(
	db: Db,
	input: {
		skuId: number;
		quantity: number;
		locationId: number;
		reference: string;
	},
) {
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const sku = await getSku(tx, input.skuId);
		const taken =
			sku.kind === "bundle"
				? (await getRecipe(tx, sku.id)).map((c) => ({
						skuId: c.skuId,
						quantity: c.quantity * input.quantity,
					}))
				: [{ skuId: sku.id, quantity: input.quantity }];
		if (taken.length === 0)
			throw new LedgerError(`Bundle ${sku.sku} has no components`);

		return postMovements(tx, {
			reference: input.reference,
			lines: taken.map((t) => ({
				skuId: t.skuId,
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
		kitSkuId: number;
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
		kitSkuId: number;
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
		kitSkuId: number;
		quantity: number;
		locationId: number;
		reference?: string;
	},
	direction: "assemble" | "disassemble",
) {
	assertPositiveInteger(input.quantity);
	return db.transaction(async (tx) => {
		const kit = await getSku(tx, input.kitSkuId);
		if (kit.kind !== "kit") throw new LedgerError(`${kit.sku} is not a kit`);
		const recipe = await getRecipe(tx, kit.id);
		if (recipe.length === 0)
			throw new LedgerError(`Kit ${kit.sku} has no components`);

		const sign = direction === "assemble" ? 1 : -1;
		const result = await postMovements(tx, {
			reference: input.reference,
			lines: [
				{
					skuId: kit.id,
					locationId: input.locationId,
					delta: sign * input.quantity,
					reason:
						direction === "assemble" ? "assembly_produce" : "assembly_consume",
				},
				...recipe.map((c) => ({
					skuId: c.skuId,
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
			direction === "assemble" ? recipe.map((c) => c.skuId) : [kit.id],
		);
		const short = result.levels.filter(
			(l) => consumed.has(l.skuId) && l.onHand < 0,
		);
		if (short.length > 0) {
			const shortSkus = await tx
				.select({ sku: skus.sku })
				.from(skus)
				.where(
					inArray(
						skus.id,
						short.map((l) => l.skuId),
					),
				);
			throw new LedgerError(
				`Not enough stock to ${direction} ${input.quantity} × ${kit.sku}: ${shortSkus.map((s) => s.sku).join(", ")}`,
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
