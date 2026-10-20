import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, locations, movements, products, stores } from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import type { Found } from "./channel";

// Stock pull: once, before stock push goes on, sets every product katasync
// has no stock record for to what a channel shows. No stock record means its
// ledger holds nothing but sales and returns: the Sumtracker import had no
// stock for it, and nobody has received or counted it since. For those the
// channel's number is the only record there is (and already has those sales
// taken off), so pushing it back changes nothing until someone counts. A
// product katasync tracks is never touched: its ledger is the truth.

// A channel quantity this high is someone's stand-in for "plenty", not stock,
// so it isn't pulled.
export const PLACEHOLDER_FROM = 500;

// One store's stock read, in the order to trust them (the primary store first).
export type StoreRead = {
	storeId: number;
	store: string;
	found: Map<string, Found<unknown>>;
};

export type Pull = {
	productId: number;
	sku: string;
	// What the product's stock becomes.
	quantity: number;
	store: string;
	// The store's listings showed different numbers; the lowest is taken.
	disagreed: boolean;
};

// A stockless product no store gave a usable number for.
export type Unpulled = {
	sku: string;
	why: "untracked" | "placeholder" | "unreported";
	detail: string;
};

export type PullPlan = { pulls: Pull[]; unpulled: Unpulled[] };

const untracked = sql`not exists (select 1 from ${movements} where ${movements.productId} = ${products.id} and ${movements.reason} not in ('sale', 'return'))`;

// The products with no stock record, each with its mapped listings.
async function stockless(db: Db) {
	const rows = await db
		.select({
			productId: products.id,
			sku: products.sku,
			storeId: listings.storeId,
			externalId: listings.externalId,
		})
		.from(products)
		.innerJoin(listings, eq(listings.productId, products.id))
		.where(
			and(
				ne(products.kind, "bundle"),
				isNull(products.archivedAt),
				untracked,
				eq(listings.fulfillment, "merchant"),
				sql`coalesce(${listings.status}, '') <> 'DELETED'`,
			),
		)
		.orderBy(asc(products.sku));
	const bySku = new Map<
		string,
		{ productId: number; sku: string; listings: typeof rows }
	>();
	for (const r of rows) {
		const p = bySku.get(r.sku) ?? {
			productId: r.productId,
			sku: r.sku,
			listings: [],
		};
		p.listings.push(r);
		bySku.set(r.sku, p);
	}
	return [...bySku.values()];
}

// What a pull would take, from reads in trust order. The first store with a
// real number for a product decides it, even when that number is 0.
export async function planStockPull(
	db: Db,
	reads: StoreRead[],
): Promise<PullPlan> {
	const pulls: Pull[] = [];
	const unpulled: Unpulled[] = [];
	for (const p of await stockless(db)) {
		const notes: Unpulled[] = [];
		let pull: Pull | null = null;
		for (const read of reads) {
			const shown = p.listings
				.filter((l) => l.storeId === read.storeId)
				.map((l) => read.found.get(l.externalId));
			const numbers: number[] = [];
			for (const f of shown) {
				if (!f || (f.state === "ready" && f.shows === null)) continue;
				if (f.state === "unpushable")
					notes.push({
						sku: p.sku,
						why: "untracked",
						detail: `${read.store}: ${f.reason}`,
					});
				else if (f.shows !== null && f.shows >= PLACEHOLDER_FROM)
					notes.push({
						sku: p.sku,
						why: "placeholder",
						detail: `${read.store} shows ${f.shows}`,
					});
				else if (f.shows !== null) numbers.push(Math.max(0, f.shows));
			}
			if (numbers.length > 0) {
				pull = {
					productId: p.productId,
					sku: p.sku,
					quantity: Math.min(...numbers),
					store: read.store,
					disagreed: new Set(numbers).size > 1,
				};
				break;
			}
		}
		if (pull) pulls.push(pull);
		else
			unpulled.push(
				notes[0] ?? {
					sku: p.sku,
					why: "unreported",
					detail: "no store reported its stock",
				},
			);
	}
	return { pulls, unpulled };
}

// Posts what takes each product from its ledger to the plan's quantity, as
// opening stock on our own shelf. A product that gained a stock record since
// the plan (a receipt, a count, or this having run already) is skipped, so a
// pull can't count anything twice. Returns how many it put on record.
export async function applyStockPull(db: Db, plan: PullPlan) {
	const wanted = plan.pulls;
	if (wanted.length === 0) return 0;
	return db.transaction(async (tx) => {
		const [shelf] = await tx
			.select({ id: locations.id })
			.from(locations)
			.where(eq(locations.kind, "owned"))
			.orderBy(asc(locations.id))
			.limit(1);
		if (!shelf)
			throw new Error("There's no location of our own to put stock on.");
		// Serializes with sales posting, so none lands between reading the
		// ledger and posting on top of it.
		await tx.execute(sql`lock table ${movements} in share row exclusive mode`);
		const ids = wanted.map((p) => p.productId);
		const eligible = await tx
			.select({ id: products.id })
			.from(products)
			.where(and(inArray(products.id, ids), untracked));
		const ledger = await tx
			.select({
				productId: movements.productId,
				onHand: sql<number>`sum(${movements.delta})::int`,
			})
			.from(movements)
			.where(inArray(movements.productId, ids))
			.groupBy(movements.productId);
		const still = new Map<number, number>(
			eligible.map((r) => [
				r.id,
				ledger.find((l) => l.productId === r.id)?.onHand ?? 0,
			]),
		);
		const lines = wanted.flatMap((p) => {
			const onHand = still.get(p.productId);
			// Even when it already matches, so the product is on record (an
			// opening balance of 0 is allowed) and no later pull takes it.
			if (onHand === undefined) return [];
			return [
				{
					productId: p.productId,
					locationId: shelf.id,
					delta: p.quantity - onHand,
					reason: "opening_balance" as const,
				},
			];
		});
		if (lines.length === 0) return 0;
		await postMovements(tx, {
			lines,
			reference: "stock-pull",
			note: "Opening stock taken from the channels before stock push",
		});
		return lines.length;
	});
}

// The stores in the order to trust their numbers: the primary store first.
export async function storesInTrustOrder(db: Db) {
	const all = await db.select().from(stores).orderBy(asc(stores.id));
	const rank = { shopify: 0, tiktok: 1, amazon: 2, ebay: 3 } as const;
	return all.sort((a, b) => rank[a.channel] - rank[b.channel]);
}
