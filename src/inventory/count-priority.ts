import { and, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { countLog, locations, products, stockLevels } from "#/db/schema";
import { type AbcClass, abcClasses } from "#/inventory/abc";
import { TRUST_DAYS } from "#/inventory/stock-state";

// What to count next, across every shelf of ours, not only the requested
// ones. A shelf is due when its number can't be trusted: it's below zero,
// someone asked for a count, or no count in TRUST_DAYS vouches for it. A
// count clears every reason but oversold, which clears once the shelf holds
// what was counted.

// Most urgent first.
export const COUNT_REASONS = [
	// On hand below zero: the number is wrong for sure.
	"oversold",
	// Someone asked: it's on the staff's count list.
	"requested",
	// No count in TRUST_DAYS, or never one.
	"stale",
] as const;
export type CountReason = (typeof COUNT_REASONS)[number];

// How far back a shelf's missed counts are looked for.
export const MISS_DAYS = 365;

export type Shelf = {
	productId: number;
	sku: string;
	name: string;
	category: string | null;
	locationId: number;
	location: string;
	abc: AbcClass | null;
	onHand: number;
	lastCountedAt: Date | null;
	countRequestedAt: Date | null;
	// Counts in MISS_DAYS that didn't match, leaving out undone ones.
	misses: number;
};

export type DueShelf = Shelf & { reason: CountReason };

// Why a shelf is due, or null when its number can be trusted.
export function reasonOf(s: Shelf, now: Date): CountReason | null {
	if (s.onHand < 0) return "oversold";
	if (
		s.countRequestedAt &&
		(!s.lastCountedAt || s.lastCountedAt < s.countRequestedAt)
	)
		return "requested";
	if (
		!s.lastCountedAt ||
		now.getTime() - s.lastCountedAt.getTime() > TRUST_DAYS * 86_400_000
	)
		return "stale";
	return null;
}

// Due shelves, most urgent first: by reason, then A before B before C (they
// carry the money and wait on a count before ordering), then shelves that
// keep missing, then the longest waiting. Never counted waits longest.
export function rankCounts(shelves: Shelf[], now: Date): DueShelf[] {
	const abcOrder = { A: 0, B: 1, C: 2 };
	const waitingSince = (s: DueShelf) =>
		(s.reason === "requested"
			? s.countRequestedAt
			: s.lastCountedAt
		)?.getTime() ?? 0;
	return shelves
		.flatMap((s) => {
			const reason = reasonOf(s, now);
			return reason ? [{ ...s, reason }] : [];
		})
		.sort(
			(a, b) =>
				COUNT_REASONS.indexOf(a.reason) - COUNT_REASONS.indexOf(b.reason) ||
				abcOrder[a.abc ?? "C"] - abcOrder[b.abc ?? "C"] ||
				b.misses - a.misses ||
				waitingSince(a) - waitingSince(b) ||
				a.sku.localeCompare(b.sku),
		);
}

// Every shelf of ours that could be counted: each one holding a product, and
// for a product none holds yet, our first location (where a count would put
// it). Tool sets have no shelf; their parts do.
export async function countableShelves(
	db: Db,
	now = new Date(),
): Promise<Shelf[]> {
	const since = new Date(now.getTime() - MISS_DAYS * 86_400_000);
	const [owned, items, levels, misses, abc] = await Promise.all([
		db
			.select({ id: locations.id, name: locations.name })
			.from(locations)
			.where(eq(locations.kind, "owned")),
		db
			.select({
				id: products.id,
				sku: products.sku,
				name: products.name,
				category: products.category,
			})
			.from(products)
			.where(ne(products.kind, "bundle")),
		db
			.select({
				productId: stockLevels.productId,
				locationId: stockLevels.locationId,
				onHand: stockLevels.onHand,
				lastCountedAt: stockLevels.lastCountedAt,
				countRequestedAt: stockLevels.countRequestedAt,
			})
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(eq(locations.kind, "owned")),
		db
			.select({
				productId: countLog.productId,
				locationId: countLog.locationId,
				misses: sql<number>`count(*)::int`,
			})
			.from(countLog)
			.where(
				and(
					ne(countLog.expected, countLog.counted),
					gte(countLog.countedAt, since),
					sql`not exists (select 1 from movements where movements.reference = 'undo:' || ${countLog.batchId}::text)`,
				),
			)
			.groupBy(countLog.productId, countLog.locationId),
		abcClasses(db, now),
	]);
	if (owned.length === 0) return [];

	const locationName = new Map(owned.map((l) => [l.id, l.name]));
	const first = Math.min(...owned.map((l) => l.id));
	const key = (productId: number, locationId: number) =>
		`${productId}:${locationId}`;
	const missed = new Map(
		misses.map((m) => [key(m.productId, m.locationId), m.misses]),
	);
	const held = new Map<number, typeof levels>();
	for (const l of levels)
		held.set(l.productId, [...(held.get(l.productId) ?? []), l]);

	return items.flatMap((p) => {
		const shelves = held.get(p.id) ?? [
			{
				productId: p.id,
				locationId: first,
				onHand: 0,
				lastCountedAt: null,
				countRequestedAt: null,
			},
		];
		return shelves.map((s) => ({
			...s,
			sku: p.sku,
			name: p.name,
			category: p.category,
			location: locationName.get(s.locationId) ?? "",
			abc: abc.classes.get(p.id)?.abc ?? null,
			misses: missed.get(key(p.id, s.locationId)) ?? 0,
		}));
	});
}

// The due shelves, most urgent first.
export async function countsDue(db: Db, now = new Date()) {
	return { due: rankCounts(await countableShelves(db, now), now) };
}
