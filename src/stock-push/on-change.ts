import { and, eq, gte, inArray, ne } from "drizzle-orm";
import type { Db } from "#/db/client";
import { movements, productComponents, products, stores } from "#/db/schema";
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
export async function movedSince(db: Db, since: Date): Promise<number[]> {
	const moved = await db
		.selectDistinct({ id: movements.productId })
		.from(movements)
		.where(gte(movements.createdAt, new Date(since.getTime() - SLACK_MS)));
	if (moved.length === 0) return [];
	const ids = moved.map((m) => m.id);
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
	const ids = await movedSince(db, since);
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
