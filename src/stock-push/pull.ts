import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, locations, movements, products, stores } from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { lockStockProducts } from "#/inventory/ledger/post";
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

// How many movements each product had when the stores were read. Movements are
// append-only, so a count that has grown means something posted since.
export type LedgerMark = Map<number, number>;

export type PullPlan = {
	pulls: Pull[];
	unpulled: Unpulled[];
	mark: LedgerMark;
};

export type PullResult =
	| { state: "posted"; posted: number }
	// Something posted to these products after the stores were read, so the
	// numbers may be stale. Nothing was posted; read the stores again.
	| { state: "moved"; skus: string[] };

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

// Movement counts for these products; zero for one with none.
async function movementCounts(
	db: Db,
	productIds: number[],
): Promise<LedgerMark> {
	const counts = new Map<number, number>(productIds.map((id) => [id, 0]));
	if (productIds.length === 0) return counts;
	const rows = await db
		.select({ productId: movements.productId, n: count() })
		.from(movements)
		.where(inArray(movements.productId, productIds))
		.groupBy(movements.productId);
	for (const r of rows) counts.set(r.productId, r.n);
	return counts;
}

// Marks the ledgers of the stockless products. Take it before reading the
// stores: anything that posts after this is caught when the plan is applied.
export async function markLedgers(db: Db): Promise<LedgerMark> {
	return movementCounts(
		db,
		(await stockless(db)).map((p) => p.productId),
	);
}

// What a pull would take, from reads in trust order. The first store with a
// real number for a product decides it, even when that number is 0. `mark` is
// the ledgers from before the stores were read (markLedgers). Left out, they're
// marked now, which is only right when the reads came after nothing else.
export async function planStockPull(
	db: Db,
	reads: StoreRead[],
	mark?: LedgerMark,
): Promise<PullPlan> {
	const marked = mark ?? (await markLedgers(db));
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
	return { pulls, unpulled, mark: marked };
}

// Posts what takes each product from its ledger to the plan's quantity, as
// opening stock on our own shelf. The stores' numbers are only good for the
// ledger they were read against, so if any pulled product has moved since the
// plan's mark, nothing posts and the stores must be read again: rebasing an
// old number onto a newer ledger would absorb the sales in between.
export async function applyStockPull(
	db: Db,
	plan: PullPlan,
): Promise<PullResult> {
	const wanted = plan.pulls;
	if (wanted.length === 0) return { state: "posted", posted: 0 };
	return db.transaction(async (tx): Promise<PullResult> => {
		const [shelf] = await tx
			.select({ id: locations.id })
			.from(locations)
			.where(eq(locations.kind, "owned"))
			.orderBy(asc(locations.id))
			.limit(1);
		if (!shelf)
			throw new Error("There's no location of our own to put stock on.");
		const ids = wanted.map((pull) => pull.productId);
		await lockStockProducts(tx, ids);
		// Serializes with sales posting, so none lands between reading the
		// ledger and posting on top of it.
		await tx.execute(sql`lock table ${movements} in share row exclusive mode`);
		const now = await movementCounts(tx, ids);
		const moved = wanted.filter(
			(p) => now.get(p.productId) !== plan.mark.get(p.productId),
		);
		if (moved.length > 0)
			return { state: "moved", skus: moved.map((p) => p.sku) };
		const ledger = await tx
			.select({
				productId: movements.productId,
				onHand: sql<number>`sum(${movements.delta})::int`,
			})
			.from(movements)
			.where(inArray(movements.productId, ids))
			.groupBy(movements.productId);
		const onHand = new Map(ledger.map((l) => [l.productId, l.onHand]));
		const lines = wanted.map((p) => ({
			productId: p.productId,
			locationId: shelf.id,
			// Even when it already matches, so the product is on record (an
			// opening balance of 0 is allowed) and no later pull takes it.
			delta: p.quantity - (onHand.get(p.productId) ?? 0),
			reason: "opening_balance" as const,
		}));
		await postMovements(tx, {
			lines,
			reference: "stock-pull",
			note: "Opening stock taken from the channels before stock push",
		});
		return { state: "posted", posted: lines.length };
	});
}

// The stores in the order to trust their numbers: the primary store first, so
// its number decides whenever it has one, even zero. The rest follow in channel
// order and only fill in where the primary has no number or couldn't be read.
export async function storesInTrustOrder(db: Db) {
	const all = await db.select().from(stores).orderBy(asc(stores.id));
	const rank = { shopify: 0, tiktok: 1, amazon: 2, ebay: 3 } as const;
	return all.sort(
		(a, b) =>
			Number(b.primary) - Number(a.primary) ||
			rank[a.channel] - rank[b.channel],
	);
}
