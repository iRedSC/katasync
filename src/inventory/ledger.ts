import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	countLog,
	movements,
	productComponents,
	products,
	stockCounts,
	stockLevels,
} from "#/db/schema";
import { carriedOrStocked } from "#/products/archive";

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
	return postUnits(db, { ...input, sign: -1, reason: "sale" });
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
		return postMovements(db, {
			reference: input.reference,
			lines: sold.map((line) => ({
				productId: line.productId,
				locationId: input.locationId,
				delta: (-line.delta * input.quantity) / sale.quantity,
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
		const sku = await getProduct(tx, input.productId);
		const units =
			sku.kind === "bundle"
				? (await getRecipe(tx, sku.id)).map((c) => ({
						productId: c.productId,
						quantity: c.quantity * input.quantity,
					}))
				: [{ productId: sku.id, quantity: input.quantity }];
		if (units.length === 0)
			throw new LedgerError(`Bundle ${sku.sku} has no components`);

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
	const archived = await db
		.select({ sku: products.sku })
		.from(products)
		.where(
			and(inArray(products.id, input.productIds), sql`not ${carriedOrStocked}`),
		);
	if (archived.length > 0)
		throw new LedgerError(
			`Archived with none on hand, so not on the count list; restore them first: ${archived.map((b) => b.sku).join(", ")}`,
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
