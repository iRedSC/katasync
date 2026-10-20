import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import {
	locations,
	productComponents,
	products,
	stockLevels,
} from "#/db/schema";
import { abcClasses } from "#/inventory/abc";
import {
	cancelCountRequests,
	recordCount as recordShelfCount,
	requestCounts,
} from "#/inventory/ledger";
import { isOurs } from "#/inventory/locations";
import { ownedLocationIds } from "./owned-locations";

// Records what someone counted on the shelf. The app works out the change, and
// the location when there's only one.
export const recordCount = createServerFn({ method: "POST" })
	.validator(
		type({
			sku: "string > 0",
			counted: "number.integer",
			reason: "'count' | 'damaged' | 'found' | 'other'",
			"note?": "string",
			"locationId?": "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [product] = await db
			.select({ id: products.id })
			.from(products)
			.where(eq(products.sku, data.sku));
		if (!product) throw new Error(`No product ${data.sku}`);
		const ours = await db
			.select({ id: locations.id, kind: locations.kind })
			.from(locations)
			.where(isOurs);
		if (
			data.locationId !== undefined &&
			!ours.some((l) => l.id === data.locationId)
		)
			throw new Error("That isn't one of our locations");
		const locationId =
			data.locationId ?? (ours.length === 1 ? ours[0].id : undefined);
		if (locationId === undefined) throw new Error("Pick a location");

		const labels = {
			count: "Counted",
			damaged: "Damaged",
			found: "Found",
			other: "Other",
		};
		return recordShelfCount(db, {
			productId: product.id,
			locationId,
			counted: data.counted,
			note: [labels[data.reason], data.note?.trim()].filter(Boolean).join(": "),
		});
	});

// A shelf is due once someone asks for a count, until a count lands after
// the request.
export const countDue = and(
	isNotNull(stockLevels.countRequestedAt),
	sql`(${stockLevels.lastCountedAt} is null or ${stockLevels.lastCountedAt} < ${stockLevels.countRequestedAt})`,
	isOurs,
);

// Puts a product on the count list at every shelf of ours holding it, or our
// first location when none does yet. Returns the shelves this put on the list,
// leaving out any already waiting, so undo takes off only those.
export const requestCount = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		// A tool set has no shelf of its own, so counting it means its parts.
		const parts = await db
			.select({ id: productComponents.componentProductId })
			.from(productComponents)
			.where(eq(productComponents.parentProductId, data.productId));
		const added = [];
		for (const productId of parts.length > 0
			? parts.map((p) => p.id)
			: [data.productId])
			added.push(...(await requestShelfCounts(db, productId)));
		return added;
	});

// Puts each of our shelves holding the product on the count list, or the
// warehouse when none holds it yet.
async function requestShelfCounts(db: Db, productId: number) {
	const [held, owned] = await Promise.all([
		db
			.select({ locationId: stockLevels.locationId })
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(and(eq(stockLevels.productId, productId), isOurs)),
		ownedLocationIds(),
	]);
	if (owned.length === 0) throw new Error("Add a location first");
	const at =
		held.length > 0 ? held.map((h) => h.locationId) : [Math.min(...owned)];
	const added = [];
	for (const locationId of at)
		added.push(
			...(await requestCounts(db, {
				productIds: [productId],
				locationId,
			})),
		);
	return added;
}

// Undoes requestCount. Returns how many requests came off; any that were
// counted and asked for again since stay.
export const cancelCountRequest = createServerFn({ method: "POST" })
	.validator(
		type({
			requests: type({
				productId: "number.integer > 0",
				locationId: "number.integer > 0",
				requestedAt: "string > 0",
			}).array(),
		}),
	)
	.handler(async ({ data }) => cancelCountRequests(getDb(), data.requests));

// Shelves due for a cycle count, A first, then the longest waiting.
export const listCountsDue = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [shelves, abc] = await Promise.all([
			db
				.select({
					productId: products.id,
					sku: products.sku,
					name: products.name,
					variantName: products.variantName,
					imageUrl: products.imageUrl,
					locationId: locations.id,
					location: locations.name,
					onHand: stockLevels.onHand,
					lastCountedAt: stockLevels.lastCountedAt,
					countRequestedAt: stockLevels.countRequestedAt,
				})
				.from(stockLevels)
				.innerJoin(products, eq(products.id, stockLevels.productId))
				.innerJoin(locations, eq(locations.id, stockLevels.locationId))
				.where(countDue),
			abcClasses(db),
		]);
		const order = { A: 0, B: 1, C: 2 };
		return shelves
			.map((s) => ({ ...s, abc: abc.classes.get(s.productId)?.abc ?? null }))
			.sort(
				(a, b) =>
					order[a.abc ?? "C"] - order[b.abc ?? "C"] ||
					(a.countRequestedAt?.getTime() ?? 0) -
						(b.countRequestedAt?.getTime() ?? 0) ||
					a.sku.localeCompare(b.sku),
			);
	},
);

export async function countCountsDue(db: Db) {
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(countDue);
	return count;
}
