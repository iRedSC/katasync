import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	countLog,
	movements,
	products,
	stockCounts,
	stockLevels,
} from "#/db/schema";
import {
	assertPositiveInteger,
	getProduct,
	getRecipe,
	LedgerError,
	postMovements,
	type StockLevel,
} from "./ledger/post";

export {
	LedgerError,
	type MovementLine,
	postMovements,
	type StockLevel,
} from "./ledger/post";
export { recordReturn, recordSale } from "./ledger/sales";
export { transferStock } from "./ledger/transfers";

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

// Puts shelves on the cycle count list. A shelf already waiting keeps its
// request time, and so its place in the queue. Returns the shelves this call
// put on the list, each with its exact request time (as text, since a Date
// drops the microseconds), which is what cancelCountRequests takes. Tool sets
// have no shelf of their own; ask for their parts.
export async function requestCounts(
	db: Db,
	input: { productIds: number[]; locationId: number },
) {
	if (input.productIds.length === 0) return [];
	const bundles = await db
		.select({ sku: products.sku })
		.from(products)
		.where(
			and(inArray(products.id, input.productIds), eq(products.kind, "bundle")),
		);
	if (bundles.length > 0)
		throw new LedgerError(
			`Tool sets can't be counted; ask for their parts: ${bundles.map((b) => b.sku).join(", ")}`,
		);
	return db
		.insert(stockLevels)
		.values(
			// One row per shelf, or Postgres refuses to update it twice.
			[...new Set(input.productIds)].map((productId) => ({
				productId,
				locationId: input.locationId,
				onHand: 0,
				countRequestedAt: sql`now()`,
			})),
		)
		.onConflictDoUpdate({
			target: [stockLevels.productId, stockLevels.locationId],
			set: { countRequestedAt: sql`now()` },
			// Only shelves not already waiting. Two requests at once queue on
			// the row, and the second sees the first's, so only one adds it.
			setWhere: sql`${stockLevels.countRequestedAt} is null or ${stockLevels.lastCountedAt} >= ${stockLevels.countRequestedAt}`,
		})
		.returning({
			productId: stockLevels.productId,
			locationId: stockLevels.locationId,
			requestedAt: sql<string>`${stockLevels.countRequestedAt}::text`,
		});
}

// Takes back requests made by requestCounts. Each comes off only if its
// request time is unchanged, so an old undo can't clear a newer request.
// Returns how many came off. A shelf row the request created stays, empty.
export async function cancelCountRequests(
	db: Db,
	requests: { productId: number; locationId: number; requestedAt: string }[],
) {
	return db.transaction(async (tx) => {
		let cancelled = 0;
		for (const r of requests) {
			const rows = await tx
				.update(stockLevels)
				.set({ countRequestedAt: null })
				.where(
					and(
						eq(stockLevels.productId, r.productId),
						eq(stockLevels.locationId, r.locationId),
						sql`${stockLevels.countRequestedAt} = ${r.requestedAt}::timestamptz`,
					),
				)
				.returning({ productId: stockLevels.productId });
			cancelled += rows.length;
		}
		return cancelled;
	});
}

// Puts received stock on a shelf. Oversold stock there is written off first,
// in the same batch, so the shelf restarts from 0 and undoing the receipt
// puts the oversold count back too.
export async function postReceipt(
	db: Db,
	input: {
		productId: number;
		locationId: number;
		quantity: number;
		reference: string;
	},
): Promise<{ batchId: string; levels: StockLevel[] }> {
	return db.transaction(async (tx) => {
		// Locked, so a sale landing now can't slip under the write-off.
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
		const oversold = Math.max(0, -(level?.onHand ?? 0));
		const shelf = { productId: input.productId, locationId: input.locationId };
		return postMovements(tx, {
			reference: input.reference,
			lines: [
				...(oversold > 0
					? [{ ...shelf, delta: oversold, reason: "oversold_reset" as const }]
					: []),
				{ ...shelf, delta: input.quantity, reason: "receipt" },
			],
		});
	});
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
			.select({
				onHand: stockLevels.onHand,
				lastCountedAt: stockLevels.lastCountedAt,
			})
			.from(stockLevels)
			.where(
				and(
					eq(stockLevels.productId, input.productId),
					eq(stockLevels.locationId, input.locationId),
				),
			)
			.for("update");
		// A count is what ends not counted (src/inventory/not-counted.ts), even
		// one that matches; undoing the count doesn't bring it back.
		await tx
			.update(products)
			.set({ notCountedSince: null })
			.where(eq(products.id, input.productId));
		await tx
			.update(stockLevels)
			.set({ lastCountedAt: sql`now()` })
			.where(
				and(
					eq(stockLevels.productId, input.productId),
					eq(stockLevels.locationId, input.locationId),
				),
			);
		const delta = input.counted - level.onHand;
		const log = {
			productId: input.productId,
			locationId: input.locationId,
			expected: level.onHand,
			counted: input.counted,
		};
		if (delta === 0) {
			await tx.insert(countLog).values({ ...log, countedAt: sql`now()` });
			return { delta, onHand: level.onHand, batchId: null };
		}
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
		await tx.insert(stockCounts).values({
			batchId: result.batchId,
			productId: input.productId,
			locationId: input.locationId,
			previousCountedAt: level.lastCountedAt,
		});
		await tx
			.insert(countLog)
			.values({ ...log, countedAt: sql`now()`, batchId: result.batchId });
		return {
			delta,
			onHand: result.levels[0].onHand,
			batchId: result.batchId,
		};
	});
}

// Reverses an earlier operation by posting its exact opposite, since movements
// are never edited. Each batch can be undone once. Undoing a count also puts
// back the shelf's previous count date, unless a later count has replaced it.
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
		const result = await postMovements(tx, {
			reference,
			note: original[0].note ? `Undo: ${original[0].note}` : "Undo",
			lines: original.map((m) => ({
				productId: m.productId,
				locationId: m.locationId,
				delta: -m.delta,
				reason: m.reason,
			})),
		});
		// Matching on countedAt leaves the shelf alone if anything counted it since.
		await tx
			.update(stockLevels)
			.set({ lastCountedAt: stockCounts.previousCountedAt })
			.from(stockCounts)
			.where(
				and(
					eq(stockCounts.batchId, batchId),
					eq(stockLevels.productId, stockCounts.productId),
					eq(stockLevels.locationId, stockCounts.locationId),
					eq(stockLevels.lastCountedAt, stockCounts.countedAt),
				),
			);
		return result;
	});
}
