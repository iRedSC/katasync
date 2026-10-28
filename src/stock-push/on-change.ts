import { and, eq, gte, inArray, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	stockCommitmentEntries,
	stockCommitmentParts,
	stockCommitments,
} from "#/db/quantity-schema";
import {
	locations,
	movements,
	productComponents,
	products,
	stockLevels,
	stores,
} from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import type { StockChannel } from "./channel";
import { stockChannels } from "./channels";
import {
	type PushMode,
	pushMode,
	pushStoreStock,
	type StorePush,
} from "./push";

// Pushes stock the moment it moves, rather than waiting for each channel's
// next sync pass (every four hours): after a webhook order, anything done in
// the app, and every sync pass for the other channels. Only the products whose
// stock moved, and the sets containing them, are pushed, from the quantities
// katasync last saw on the channel, so nothing extra is read and nothing that
// already matches is written.

// How far before the work began to look for movements. A movement's time is
// when its transaction began, which can be a little before the work's own
// clock; pushing a product twice costs nothing.
const SLACK_MS = 2 * 60 * 1000;

// The products whose stock moved since `since`, and every set containing one.
// Once committed, an order reserves its parts and a cancel releases them
// without a movement, and either changes what a channel can sell, so a
// commitment made, consumed, released or restored since counts as a move.
export async function movedSince(db: Db, since: Date): Promise<number[]> {
	const from = new Date(since.getTime() - SLACK_MS);
	const [moved, reserved, settled] = await Promise.all([
		db
			.selectDistinct({ id: movements.productId })
			.from(movements)
			.where(gte(movements.createdAt, from)),
		db
			.selectDistinct({ id: stockCommitmentParts.productId })
			.from(stockCommitmentParts)
			.innerJoin(
				stockCommitments,
				eq(stockCommitments.id, stockCommitmentParts.commitmentId),
			)
			.where(gte(stockCommitments.createdAt, from)),
		db
			.selectDistinct({ id: stockCommitmentParts.productId })
			.from(stockCommitmentParts)
			.innerJoin(
				stockCommitmentEntries,
				eq(
					stockCommitmentEntries.commitmentId,
					stockCommitmentParts.commitmentId,
				),
			)
			.where(gte(stockCommitmentEntries.createdAt, from)),
	]);
	return withSets(db, [
		...new Set([...moved, ...reserved, ...settled].map((m) => m.id)),
	]);
}

// The products, and every set containing one.
async function withSets(db: Db, ids: number[]): Promise<number[]> {
	if (ids.length === 0) return [];
	const sets = await db
		.selectDistinct({ id: productComponents.parentProductId })
		.from(productComponents)
		.innerJoin(products, eq(products.id, productComponents.parentProductId))
		.where(
			and(
				inArray(productComponents.componentProductId, ids),
				eq(products.kind, "bundle"),
			),
		);
	return [...new Set([...ids, ...sets.map((s) => s.id)])];
}

// Pushes what moved since `since` to every store with push on, leaving out
// `except`'s stores (a sync pass has just pushed its own in full). Never
// throws; each store's failure comes back as its problem.
export async function pushMoved(
	db: Db,
	since: Date,
	options: {
		except?: SyncedChannel;
		mode?: PushMode;
		adapters?: { [C in SyncedChannel]?: StockChannel<never> };
	} = {},
): Promise<StorePush[]> {
	return pushProducts(db, await movedSince(db, since), options);
}

// What the retail store can spare online changes for everything on its shelf
// when its reserve does, though no stock moved.
export async function pushRetailShelf(db: Db): Promise<StorePush[]> {
	const held = await db
		.selectDistinct({ id: stockLevels.productId })
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(eq(locations.kind, "retail"));
	return pushProducts(
		db,
		await withSets(
			db,
			held.map((h) => h.id),
		),
	);
}

// Pushes these products and every set containing one, e.g. after a product
// changes kind or a set's parts change, which changes what it can sell
// though no stock moved.
export async function pushProductsNow(
	db: Db,
	ids: number[],
	options: Parameters<typeof pushProducts>[2] = {},
): Promise<StorePush[]> {
	return pushProducts(db, await withSets(db, ids), options);
}

// Pushes these products to every store with push on, leaving out `except`'s
// stores. Never throws; each store's failure comes back as its problem.
async function pushProducts(
	db: Db,
	ids: number[],
	options: {
		except?: SyncedChannel;
		mode?: PushMode;
		adapters?: { [C in SyncedChannel]?: StockChannel<never> };
	} = {},
): Promise<StorePush[]> {
	if (ids.length === 0) return [];
	const on = await db
		.select()
		.from(stores)
		.where(
			and(
				eq(stores.pushStock, true),
				options.except ? ne(stores.channel, options.except) : undefined,
			),
		);
	const mode = options.mode ?? pushMode();
	const results: StorePush[] = [];
	for (const store of on)
		results.push(
			await pushStoreStock(
				db,
				store,
				options.adapters?.[store.channel] ?? stockChannels[store.channel],
				mode,
				new Date(),
				ids,
			),
		);
	return results;
}
