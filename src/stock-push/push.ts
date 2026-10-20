import { type } from "arktype";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	type ListingStockPush,
	listings,
	locations,
	products,
	stores,
} from "#/db/schema";
import type { SyncedChannel } from "#/diagnostics/checks";
import { errorText } from "#/diagnostics/runs";
import { getAvailability } from "#/inventory/availability";
import { UNLIMITED } from "#/inventory/not-counted";
import { onlineStock } from "#/inventory/online-stock";
import { chunks, type StockChannel, type StockWrite } from "./channel";

// Stock push: sets each mapped listing's quantity on its channel to what
// katasync can sell, for stores with push on. Runs at the end of every sync
// pass (src/channels/sync.ts), so a sale on one channel reaches the others
// within a pass. Only listings whose quantity differs from what the channel
// last showed are written; every READ_EVERY_MS the channel's own quantities
// are read back, so anything that drifted (someone edited stock on the
// channel) is put right. A listing no read has looked for yet (one made since
// the last read) brings the read forward, so it's set in the same pass.

export const READ_EVERY_MS = 25 * 60 * 1000;

// write: sets quantities on the channel.
// preview: works out the same changes and writes nothing. Every database but
// production's syncs the same live stores, so only production may write.
export type PushMode = "write" | "preview";

export const pushMode = (): PushMode =>
	process.env.VERCEL_ENV === "production" ? "write" : "preview";

export type Change = {
	sku: string;
	externalId: string;
	from: number | null;
	to: number;
};

export type StorePush = {
	store: string;
	changes: Change[];
	// Changes the channel refused (always 0 in preview).
	failed: number;
	problems: string[];
};

class Blocked extends Error {}

// Why no quantity katasync works out can be trusted yet, if one can't. A
// store whose orders don't take stock leaves its sales out of every number,
// and with nothing imported every listing would be set to 0.
export async function stockBlocker(db: Db): Promise<string | null> {
	const untracked = await db
		.select({ name: stores.name })
		.from(stores)
		.where(isNull(stores.stockFrom));
	if (untracked.length > 0)
		return `${untracked.map((s) => s.name).join(", ")} ${untracked.length === 1 ? "doesn't" : "don't"} take stock for ${untracked.length === 1 ? "its" : "their"} orders, so their sales would be missing from every quantity. Import the opening stock first.`;
	const [owned] = await db
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"))
		.limit(1);
	if (!owned) return "There's no location of our own to count stock from.";
	return null;
}

// Pushes stock for every store of this channel that has push on.
export async function pushChannelStock<T>(
	db: Db,
	channel: SyncedChannel,
	adapter: StockChannel<T>,
	mode: PushMode,
	now = new Date(),
): Promise<StorePush[]> {
	const on = await db
		.select()
		.from(stores)
		.where(and(eq(stores.channel, channel), eq(stores.pushStock, true)));
	const results: StorePush[] = [];
	for (const store of on)
		results.push(await pushStoreStock(db, store, adapter, mode, now));
	return results;
}

// One store's push. Never throws: a failure is kept on the store for
// Settings and returned as a problem for Diagnostics. `only` limits it to
// those products' listings (src/stock-push/on-change.ts) and skips the
// read-back, which the next full push does, unless one of them has a
// listing no read has looked for yet.
//
// Pushes to one store take turns, each in a transaction holding the store:
// each works out its quantities once it holds it, so a push that started
// earlier, with older numbers, can't write over a later one.
export async function pushStoreStock<T>(
	db: Db,
	store: typeof stores.$inferSelect,
	adapter: StockChannel<T>,
	mode: PushMode,
	now = new Date(),
	only?: number[],
): Promise<StorePush> {
	try {
		return await db.transaction(async (tx) => {
			// The transaction waits on the channel's API between statements, and
			// Neon ends ones idle for 5 minutes; a Vercel function can't outlive 15.
			await tx.execute(
				sql`set local idle_in_transaction_session_timeout = '15min'`,
			);
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext('stock-push'), ${store.id})`,
			);
			return await pushHeld(tx, store, adapter, mode, now, only);
		});
	} catch (error) {
		const message = errorText(error);
		await db
			.update(stores)
			.set({ stockPushError: message })
			.where(eq(stores.id, store.id));
		return {
			store: store.name,
			changes: [],
			failed: 0,
			problems: [`Stock push to ${store.name} stopped: ${message}`],
		};
	}
}

async function pushHeld<T>(
	db: Db,
	store: typeof stores.$inferSelect,
	adapter: StockChannel<T>,
	mode: PushMode,
	now: Date,
	only: number[] | undefined,
): Promise<StorePush> {
	const blocker = await stockBlocker(db);
	if (blocker) throw new Blocked(blocker);
	const due =
		(!only &&
			(!store.stockReadAt ||
				now.getTime() - store.stockReadAt.getTime() >= READ_EVERY_MS)) ||
		(await hasUnread(db, store, only));
	if (due) await readStock(db, store, adapter, now);
	const result = await pushListings(db, store, adapter, mode, only);
	await db
		.update(stores)
		.set({
			stockPushError: null,
			...(mode === "write" ? { stockPushedAt: now } : {}),
		})
		.where(eq(stores.id, store.id));
	return { store: store.name, ...result };
}

// The listings push sets, of `only`'s products if given: mapped, stocked by
// us, and not deleted.
const pushable = (store: typeof stores.$inferSelect, only?: number[]) =>
	and(
		eq(listings.storeId, store.id),
		eq(listings.fulfillment, "merchant"),
		isNotNull(listings.productId),
		// A deleted listing (TikTok keeps reporting them) sells nothing,
		// and the channel refuses its stock.
		sql`coalesce(${listings.status}, '') <> 'DELETED'`,
		// Nor one gone from the channel's listings.
		isNull(listings.goneAt),
		only ? inArray(listings.productId, only) : undefined,
	);

// Whether a listing push would set hasn't been looked for by any read yet.
// One the channel didn't report is `unreported`, not null, so it doesn't
// bring every read forward.
async function hasUnread(
	db: Db,
	store: typeof stores.$inferSelect,
	only: number[] | undefined,
) {
	const [row] = await db
		.select({ id: listings.id })
		.from(listings)
		.where(and(pushable(store, only), isNull(listings.stockPush)))
		.limit(1);
	return row !== undefined;
}

// Records what the channel shows for each of the store's listings. A write
// error stays until the next write tells otherwise.
async function readStock<T>(
	db: Db,
	store: typeof stores.$inferSelect,
	adapter: StockChannel<T>,
	now: Date,
) {
	const found = await adapter.read();
	const rows = await db
		.select({
			id: listings.id,
			externalId: listings.externalId,
			stockPush: listings.stockPush,
		})
		.from(listings)
		.where(eq(listings.storeId, store.id));
	await saveStockPush(
		db,
		rows.map((row) => {
			const f = found.get(row.externalId);
			const before = row.stockPush;
			const next: ListingStockPush = !f
				? { state: "unreported" }
				: f.state === "unpushable"
					? f
					: {
							state: "ready",
							target: f.target,
							shows: f.shows,
							error: before?.state === "ready" ? before.error : null,
						};
			return { id: row.id, stockPush: next };
		}),
	);
	await db
		.update(stores)
		.set({ stockReadAt: now })
		.where(eq(stores.id, store.id));
}

async function pushListings<T>(
	db: Db,
	store: typeof stores.$inferSelect,
	adapter: StockChannel<T>,
	mode: PushMode,
	only?: number[],
): Promise<Omit<StorePush, "store">> {
	const rows = await db
		.select({
			id: listings.id,
			externalId: listings.externalId,
			stockPush: listings.stockPush,
			productId: products.id,
			sku: products.sku,
			closeAt: products.closeAt,
		})
		.from(listings)
		.innerJoin(products, eq(products.id, listings.productId))
		.where(pushable(store, only))
		.orderBy(products.sku);
	// The retail store's stock sells online too: orders take from it when the
	// warehouse is out (see recordSale).
	const sellable = await getAvailability(
		db,
		[...new Set(rows.map((r) => r.productId))],
		await onlineStock(db),
		{ uncounted: UNLIMITED },
	);

	const problems: string[] = [];
	const pending: {
		row: (typeof rows)[number];
		write: StockWrite<T>;
		before: Extract<ListingStockPush, { state: "ready" }>;
	}[] = [];
	const settled: { id: number; stockPush: ListingStockPush }[] = [];
	for (const row of rows) {
		const sp = row.stockPush;
		// Null only if hasUnread raced a listing made mid-pass; the next pass
		// reads it.
		if (!sp || sp.state === "unreported") {
			problems.push(
				`${row.sku}: ${adapter.name} didn't report this listing's stock, so katasync isn't setting it`,
			);
			continue;
		}
		if (sp.state === "unpushable") {
			problems.push(
				`${row.sku}: katasync can't set its ${adapter.name} stock: ${sp.reason}`,
			);
			continue;
		}
		const target = adapter.target(sp.target);
		if (target instanceof type.errors) {
			problems.push(
				`${row.sku}: its ${adapter.name} stock address is unreadable until the next stock read`,
			);
			continue;
		}
		const has = sellable.get(row.productId) ?? 0;
		// At or below its close-at, the channels show none left.
		const quantity = row.closeAt !== null && has <= row.closeAt ? 0 : has;
		if (quantity === sp.shows) {
			// Already right, so an earlier failure no longer matters.
			if (sp.error)
				settled.push({ id: row.id, stockPush: { ...sp, error: null } });
			continue;
		}
		pending.push({
			row,
			before: sp,
			write: { externalId: row.externalId, target: target as T, quantity },
		});
	}

	const changes = pending.map(({ row, before, write }) => ({
		sku: row.sku,
		externalId: row.externalId,
		from: before.shows,
		to: write.quantity,
	}));
	if (mode === "preview") {
		await saveStockPush(db, settled);
		if (changes.length > 0)
			problems.push(
				`Stock push to ${store.name} is preview only here (not production): ${changes.length} ${changes.length === 1 ? "listing" : "listings"} would change`,
			);
		return { changes, failed: 0, problems };
	}

	const failures =
		pending.length > 0
			? await adapter.write(pending.map((p) => p.write))
			: new Map<string, string>();
	for (const { row, before, write } of pending) {
		const error = failures.get(row.externalId) ?? null;
		if (error)
			problems.push(`${row.sku}: ${adapter.name} refused its stock: ${error}`);
		settled.push({
			id: row.id,
			stockPush: {
				...before,
				shows: error ? before.shows : write.quantity,
				error,
			},
		});
	}
	await saveStockPush(db, settled);
	return { changes, failed: failures.size, problems };
}

// Writes many listings' stock push state in a few statements.
async function saveStockPush(
	db: Db,
	rows: { id: number; stockPush: ListingStockPush }[],
) {
	for (const part of chunks(rows, 500)) {
		await db.execute(sql`
			update ${listings} set stock_push = v.stock_push
			from jsonb_to_recordset(${JSON.stringify(part.map((r) => ({ id: r.id, stock_push: r.stockPush })))}::jsonb)
				as v(id integer, stock_push jsonb)
			where ${listings.id} = v.id`);
	}
}
