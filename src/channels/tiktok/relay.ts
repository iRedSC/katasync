import { eq, sql } from "drizzle-orm";
import type { StockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import {
	type ChannelOrder,
	type IngestStore,
	ingestOrder,
} from "#/orders/ingest";

// A TikTok order Shopify relayed is written by two syncs under different
// channel locks: Shopify's, until TikTok syncs itself, and TikTok's takeover,
// which moves it to the TikTok store. Both hold this lock on the TikTok order
// while they write it, so Shopify can't save it again under its own id while
// the takeover moves it, which would take its stock a second time.
// `tx` must be a transaction; the lock is held until it ends.
export async function lockRelayedOrder(tx: Db, marketplaceOrderId: string) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtext('tiktok-relay'), hashtext(${marketplaceOrderId}))`,
	);
}

// The TikTok store exists once a direct TikTok sync has reached TikTok, and
// from then on TikTok orders come from there.
export async function hasTiktokStore(db: Db) {
	const [row] = await db
		.select({ id: stores.id })
		.from(stores)
		.where(eq(stores.channel, "tiktok"))
		.limit(1);
	return Boolean(row);
}

// Saves a TikTok order as Shopify relayed it, unless TikTok syncs itself by
// the time the lock is held: a pass that checked before TikTok's first sync
// would otherwise recreate an order the takeover just moved. Null when it's
// left to TikTok.
export async function ingestRelayed(
	db: Db,
	store: IngestStore,
	order: ChannelOrder & { marketplaceOrderId: string },
	stock: StockLocations,
) {
	return db.transaction(async (tx) => {
		await lockRelayedOrder(tx, order.marketplaceOrderId);
		if (await hasTiktokStore(tx)) return null;
		return ingestOrder(tx, store, order, stock);
	});
}
