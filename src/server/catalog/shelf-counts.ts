import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { getDb } from "#/db/client";
import { locations, products, stockLevels } from "#/db/schema";
import { abcClasses } from "#/inventory/abc";
import { requestProductCount } from "#/inventory/count-requests";
import { countDue } from "#/inventory/counts-due";
import {
	cancelCountRequests,
	recordCount as recordShelfCount,
} from "#/inventory/ledger";
import { isOurs } from "#/inventory/locations";

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

// Puts a product on the count list at every shelf of ours holding it; see
// requestProductCount.
export const requestCount = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0" }))
	.handler(async ({ data }) => requestProductCount(getDb(), data.productId));

// requestCount for many products at once. Undo takes the lot.
export const requestManyCounts = createServerFn({ method: "POST" })
	.validator(type({ productIds: type("number.integer > 0").array() }))
	.handler(async ({ data }) => {
		const db = getDb();
		const added = [];
		for (const productId of data.productIds)
			added.push(...(await requestProductCount(db, productId)));
		return added;
	});

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
