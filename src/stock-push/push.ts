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
import { chunks, type StockChannel } from "./channel";
import { STOCK_WRITE_HOLD } from "./policy";

export const READ_EVERY_MS = 25 * 60 * 1000;

export type PushMode = "preview";

export const pushMode = (): PushMode => "preview";

export type Change = {
	sku: string;
	externalId: string;
	from: number | null;
	to: number;
	state: "blocked";
};

export type StorePush = {
	store: string;
	changes: Change[];
	// Changes the channel refused (always 0 in preview).
	failed: number;
	blocked: number;
	problems: string[];
};

class Blocked extends Error {}

export const stockBlocker = (): string => STOCK_WRITE_HOLD;

async function inventoryBlocker(db: Db): Promise<string | null> {
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

// Holds a store's push lock until the transaction ends. Anything that reads or
// changes a store's push settings takes it first, so it waits for a push in
// flight and a queued push sees the change.
export async function holdStore(tx: Db, storeId: number) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtext('stock-push'), ${storeId})`,
	);
}

export async function pushStoreStock<T>(
	db: Db,
	store: typeof stores.$inferSelect,
	adapter: StockChannel<T>,
	mode: PushMode,
	now = new Date(),
	only?: number[],
	refresh = false,
): Promise<StorePush> {
	try {
		if (mode !== "preview") throw new Blocked(STOCK_WRITE_HOLD);
		return await db.transaction(async (tx) => {
			// The transaction waits on the channel's API between statements, and
			// Neon ends ones idle for 5 minutes; a Vercel function can't outlive 15.
			await tx.execute(
				sql`set local idle_in_transaction_session_timeout = '15min'`,
			);
			await holdStore(tx, store.id);
			const [held] = await tx
				.select()
				.from(stores)
				.where(eq(stores.id, store.id));
			if (!held)
				return {
					store: store.name,
					changes: [],
					failed: 0,
					blocked: 0,
					problems: [],
				};
			return await pushHeld(tx, held, adapter, now, only, refresh);
		});
	} catch (error) {
		const message = errorText(error);
		await db
			.update(stores)
			.set({ stockPushError: message, stockReadAt: null })
			.where(eq(stores.id, store.id));
		return {
			store: store.name,
			changes: [],
			failed: 0,
			blocked: 0,
			problems: [`Stock push to ${store.name} stopped: ${message}`],
		};
	}
}

async function pushHeld<T>(
	db: Db,
	store: typeof stores.$inferSelect,
	adapter: StockChannel<T>,
	now: Date,
	only: number[] | undefined,
	refresh: boolean,
): Promise<StorePush> {
	const blocker = await inventoryBlocker(db);
	if (blocker) throw new Blocked(blocker);
	const due =
		refresh ||
		(!only &&
			(!store.stockReadAt ||
				now.getTime() - store.stockReadAt.getTime() >= READ_EVERY_MS)) ||
		(await hasUnread(db, store, only));
	if (due) await readStock(db, store, adapter, now);
	const result = await pushListings(db, store, adapter, only);
	await db
		.update(stores)
		.set({
			stockPushError: STOCK_WRITE_HOLD,
		})
		.where(eq(stores.id, store.id));
	return { store: store.name, ...result };
}

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

	const problems: string[] = [STOCK_WRITE_HOLD];
	const changes: Change[] = [];
	const settled: { id: number; stockPush: ListingStockPush }[] = [];
	let blocked = 0;
	for (const row of rows) {
		const sp = row.stockPush;
		if (!sp || sp.state === "unreported") {
			problems.push(
				`${row.sku}: ${adapter.name} did not report this listing's stock`,
			);
			continue;
		}
		if (sp.state === "unpushable") {
			problems.push(`${row.sku}: ${sp.reason}`);
			continue;
		}
		const target = adapter.target(sp.target);
		if (target instanceof type.errors) {
			problems.push(
				`${row.sku}: its ${adapter.name} stock address is unreadable`,
			);
			continue;
		}
		const has = sellable.get(row.productId) ?? 0;
		const quantity = row.closeAt !== null && has <= row.closeAt ? 0 : has;
		blocked++;
		if (quantity !== sp.shows)
			changes.push({
				sku: row.sku,
				externalId: row.externalId,
				from: sp.shows,
				to: quantity,
				state: "blocked",
			});
		settled.push({
			id: row.id,
			stockPush: {
				...sp,
				error: STOCK_WRITE_HOLD,
				delivery: { kind: "blocked", wanted: quantity },
			},
		});
	}
	await saveStockPush(db, settled);
	return { changes, failed: 0, blocked, problems };
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
