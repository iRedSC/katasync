import { eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { listings, type marketStanding, products, stores } from "#/db/schema";
import type { Market } from "./market";
import type { Level, Problem, ProblemItem } from "./standing";

// Everything the marketplaces flagged, in one list to work through: worst
// first, each with the marketplace's own words and the listings or orders
// it's about, matched to our products where katasync knows the listing. A
// check that failed is on it too, since its market's problems may be stale.

export type QueueProduct = {
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
};

export type QueueEntry = Omit<Problem, "items"> & {
	// Stable across checks while the problem reads the same.
	key: string;
	market: Market;
	items: (ProblemItem & { product: QueueProduct | null })[];
	// When the marketplace last said so.
	checkedAt: Date | null;
};

type Row = typeof marketStanding.$inferSelect;

const rank: Record<Exclude<Level, "good">, number> = { at_risk: 0, watch: 1 };

export async function attentionQueue(
	db: Db,
	rows: Row[],
): Promise<QueueEntry[]> {
	// Each listing ID once, however many problems name it.
	const wanted = new Set(
		rows.flatMap((r) =>
			(r.standing?.problems ?? []).flatMap((p) =>
				p.items.flatMap((i) => (i.listingId ? [i.listingId] : [])),
			),
		),
	);
	// Keyed by marketplace and listing ID: the same ID can be on two marketplaces.
	const found = new Map<string, QueueProduct>();
	if (wanted.size > 0) {
		const listed = await db
			.select({
				channel: stores.channel,
				externalId: listings.externalId,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
			})
			.from(listings)
			.innerJoin(stores, eq(stores.id, listings.storeId))
			.innerJoin(products, eq(products.id, listings.productId))
			.where(inArray(listings.externalId, [...wanted]));
		for (const f of listed) {
			// Two stores can share an external ID; the first one listed wins.
			const key = `${f.channel}|${f.externalId}`;
			if (found.has(key)) continue;
			found.set(key, {
				sku: f.sku,
				name: f.name,
				variantName: f.variantName,
				imageUrl: f.imageUrl,
			});
		}
	}
	const productOf = (market: Market, id: string | null) =>
		id ? (found.get(`${market}|${id}`) ?? null) : null;

	const entries: QueueEntry[] = rows.flatMap((r) => [
		...(r.error
			? [
					{
						key: `${r.market}|check`,
						market: r.market,
						level: "watch" as const,
						text: "Couldn't check standing",
						href: null,
						detail: r.error,
						items: [],
						checkedAt: r.erroredAt,
					},
				]
			: []),
		...(r.standing?.problems ?? []).map((p) => ({
			...p,
			key: `${r.market}|${p.text}`,
			market: r.market,
			items: p.items.map((i) => ({
				...i,
				product: productOf(r.market, i.listingId),
			})),
			checkedAt: r.checkedAt,
		})),
	]);
	return entries.sort(
		(a, b) =>
			rank[a.level] - rank[b.level] ||
			b.items.length - a.items.length ||
			a.text.localeCompare(b.text),
	);
}
