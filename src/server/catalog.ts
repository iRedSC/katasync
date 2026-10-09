import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import {
	listings,
	locations,
	movements,
	productAliases,
	productComponents,
	productGroups,
	products,
	stockLevels,
	stores,
} from "#/db/schema";
import { getAvailability, getBundleBlockers } from "#/inventory/availability";
import { recordCount as recordShelfCount, undoBatch } from "#/inventory/ledger";

async function ownedLocationIds() {
	const rows = await getDb()
		.select({ id: locations.id })
		.from(locations)
		.where(eq(locations.kind, "owned"));
	return rows.map((r) => r.id);
}

// Every product with what's sellable from owned locations. Small enough
// (a few thousand rows) to filter in the browser.
export const listProducts = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const rows = await db
			.select({
				id: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				kind: products.kind,
				category: products.category,
				imageUrl: products.imageUrl,
				unitCost: products.unitCost,
				group: productGroups.name,
			})
			.from(products)
			.leftJoin(productGroups, eq(productGroups.id, products.groupId))
			.orderBy(products.name, products.variantName);
		const [available, onHandRows] = await Promise.all([
			ownedLocationIds().then((owned) =>
				getAvailability(
					db,
					rows.map((r) => r.id),
					owned,
				),
			),
			db
				.select({
					productId: stockLevels.productId,
					onHand: sql<number>`sum(${stockLevels.onHand})::int`,
				})
				.from(stockLevels)
				.innerJoin(locations, eq(locations.id, stockLevels.locationId))
				.where(eq(locations.kind, "owned"))
				.groupBy(stockLevels.productId),
		]);
		const onHand = new Map(onHandRows.map((r) => [r.productId, r.onHand]));
		return rows.map((r) => ({
			...r,
			onHand: r.kind === "bundle" ? null : (onHand.get(r.id) ?? 0),
			available: available.get(r.id) ?? 0,
		}));
	},
);

export const getProductDetail = createServerFn({ method: "GET" })
	.validator(type({ sku: "string > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [product] = await db
			.select()
			.from(products)
			.where(eq(products.sku, data.sku));
		if (!product) throw new Error(`No product ${data.sku}`);

		// Everything below depends only on the product, so it runs at once:
		// one round trip of waiting instead of a dozen in a row.
		const owned = db
			.select({ id: locations.id, name: locations.name })
			.from(locations)
			.where(eq(locations.kind, "owned"))
			.orderBy(locations.name);
		const [
			group,
			variants,
			components,
			usedIn,
			stock,
			aliases,
			productListings,
			history,
			ownedLocations,
		] = await Promise.all([
			product.groupId
				? db
						.select()
						.from(productGroups)
						.where(eq(productGroups.id, product.groupId))
						.then((rows) => rows[0] ?? null)
				: null,
			product.groupId
				? db
						.select({ sku: products.sku, variantName: products.variantName })
						.from(products)
						.where(eq(products.groupId, product.groupId))
						.orderBy(products.variantName)
				: [],
			db
				.select({
					sku: products.sku,
					name: products.name,
					variantName: products.variantName,
					quantity: productComponents.quantity,
					id: products.id,
				})
				.from(productComponents)
				.innerJoin(
					products,
					eq(products.id, productComponents.componentProductId),
				)
				.where(eq(productComponents.parentProductId, product.id)),
			db
				.select({
					sku: products.sku,
					name: products.name,
					quantity: productComponents.quantity,
				})
				.from(productComponents)
				.innerJoin(products, eq(products.id, productComponents.parentProductId))
				.where(eq(productComponents.componentProductId, product.id))
				.orderBy(products.sku),
			db
				.select({
					location: locations.name,
					kind: locations.kind,
					onHand: stockLevels.onHand,
				})
				.from(stockLevels)
				.innerJoin(locations, eq(locations.id, stockLevels.locationId))
				.where(eq(stockLevels.productId, product.id))
				.orderBy(locations.name),
			db
				.select({ alias: productAliases.alias })
				.from(productAliases)
				.where(eq(productAliases.productId, product.id)),
			db
				.select({
					store: stores.name,
					channel: stores.channel,
					externalId: listings.externalId,
					externalSku: listings.externalSku,
					title: listings.title,
					fulfillment: listings.fulfillment,
				})
				.from(listings)
				.innerJoin(stores, eq(stores.id, listings.storeId))
				.where(eq(listings.productId, product.id)),
			db
				.select({
					id: movements.id,
					createdAt: movements.createdAt,
					location: locations.name,
					delta: movements.delta,
					reason: movements.reason,
					reference: movements.reference,
					note: movements.note,
				})
				.from(movements)
				.innerJoin(locations, eq(locations.id, movements.locationId))
				.where(eq(movements.productId, product.id))
				.orderBy(desc(movements.id))
				.limit(50),
			owned,
		]);

		// The product and its parts in one availability lookup.
		const availability = await getAvailability(
			db,
			[product.id, ...components.map((c) => c.id)],
			ownedLocations.map((l) => l.id),
		);

		return {
			product,
			group,
			variants,
			components: components.map((c) => ({
				...c,
				available: availability.get(c.id) ?? 0,
			})),
			usedIn,
			stock,
			aliases: aliases.map((a) => a.alias),
			listings: productListings,
			history,
			available: availability.get(product.id) ?? 0,
			// Where a count could be recorded. One location means nobody has to pick.
			locations: ownedLocations,
		};
	});

export const getDashboard = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const owned = await ownedLocationIds();

		const [stock] = await db
			.select({
				units: sql<number>`coalesce(sum(greatest(${stockLevels.onHand}, 0)), 0)::int`,
				value: sql<number>`coalesce(sum(greatest(${stockLevels.onHand}, 0) * ${products.unitCost}), 0)::float`,
				// Stocked products with no cost make the value an undercount.
				uncosted: sql<number>`count(*) filter (where ${stockLevels.onHand} > 0 and ${products.unitCost} is null)::int`,
			})
			.from(stockLevels)
			.innerJoin(products, eq(products.id, stockLevels.productId));

		const oversold = await db
			.select({
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				onHand: stockLevels.onHand,
			})
			.from(stockLevels)
			.innerJoin(products, eq(products.id, stockLevels.productId))
			.where(lt(stockLevels.onHand, 0))
			.orderBy(stockLevels.onHand);

		const blockers = await getBundleBlockers(db, owned);
		const blockerIds = blockers.slice(0, 6).map((b) => b.productId);
		const blockerProducts = new Map(
			(blockerIds.length === 0
				? []
				: await db
						.select({
							id: products.id,
							sku: products.sku,
							name: products.name,
							variantName: products.variantName,
							imageUrl: products.imageUrl,
						})
						.from(products)
						.where(inArray(products.id, blockerIds))
			).map((p) => [p.id, p]),
		);
		const blockedBundles = new Set(blockers.flatMap((b) => b.blocks)).size;

		const byCategory = await db
			.select({
				category: sql<string>`coalesce(${products.category}, 'Uncategorized')`,
				value: sql<number>`sum(greatest(${stockLevels.onHand}, 0) * ${products.unitCost})::float`,
				units: sql<number>`sum(greatest(${stockLevels.onHand}, 0))::int`,
			})
			.from(stockLevels)
			.innerJoin(products, eq(products.id, stockLevels.productId))
			.where(
				sql`${products.unitCost} is not null and ${stockLevels.onHand} > 0`,
			)
			.groupBy(sql`1`)
			.orderBy(sql`2 desc`);

		const [{ bundles }] = await db
			.select({ bundles: sql<number>`count(*)::int` })
			.from(products)
			.where(eq(products.kind, "bundle"));
		const [{ unmapped }] = await db
			.select({ unmapped: sql<number>`count(*)::int` })
			.from(listings)
			.where(sql`${listings.productId} is null`);

		return {
			...stock,
			oversold,
			blockers: blockers.slice(0, 6).map((b) => ({
				...(blockerProducts.get(b.productId) ?? {
					sku: "?",
					name: "?",
					variantName: null,
					imageUrl: null,
				}),
				blocks: b.blocks.length,
			})),
			blockedBundles,
			bundles,
			unmapped,
			// Top categories by value. The long tail is summed separately rather
			// than drawn as a bar, where it would dwarf the real categories.
			byCategory: byCategory.slice(0, 8),
			otherCategories: {
				count: Math.max(byCategory.length - 8, 0),
				value: byCategory.slice(8).reduce((sum, c) => sum + c.value, 0),
			},
		};
	},
);

// The ledger, one row per operation: an import or an assembly reads as one
// line instead of hundreds.
export const listMovementBatches = createServerFn({ method: "GET" }).handler(
	async () => {
		const rows = await getDb()
			.select({
				batchId: movements.batchId,
				createdAt: sql<Date>`min(${movements.createdAt})`,
				lines: sql<number>`count(*)::int`,
				delta: sql<number>`sum(${movements.delta})::int`,
				// node-postgres can't parse arrays of enums, so join to text.
				reasons: sql<string>`string_agg(distinct ${movements.reason}::text, ',')`,
				reference: sql<string | null>`max(${movements.reference})`,
				note: sql<string | null>`max(${movements.note})`,
				sku: sql<string>`min(${products.sku})`,
				name: sql<string>`min(${products.name})`,
				imageUrl: sql<string | null>`min(${products.imageUrl})`,
			})
			.from(movements)
			.innerJoin(products, eq(products.id, movements.productId))
			.groupBy(movements.batchId)
			.orderBy(sql`max(${movements.id}) desc`)
			.limit(100);
		return rows.map((r) => ({
			...r,
			reasons: r.reasons.split(","),
			createdAt: new Date(r.createdAt),
		}));
	},
);

export const listProductIndex = createServerFn({ method: "GET" }).handler(
	async () =>
		getDb()
			.select({
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
			})
			.from(products)
			.orderBy(products.sku),
);

export const listLocations = createServerFn({ method: "GET" }).handler(
	async () => getDb().select().from(locations).orderBy(locations.name),
);

export const listStores = createServerFn({ method: "GET" }).handler(async () =>
	getDb().select().from(stores).orderBy(stores.name),
);

export const listUnmappedListings = createServerFn({ method: "GET" }).handler(
	async () =>
		getDb()
			.select({
				id: listings.id,
				store: stores.name,
				channel: stores.channel,
				externalId: listings.externalId,
				externalSku: listings.externalSku,
				title: listings.title,
				fulfillment: listings.fulfillment,
			})
			.from(listings)
			.innerJoin(stores, eq(stores.id, listings.storeId))
			.where(sql`${listings.productId} is null`),
);

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
		const owned = await ownedLocationIds();
		const locationId =
			data.locationId ?? (owned.length === 1 ? owned[0] : undefined);
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

export const undoMovement = createServerFn({ method: "POST" })
	.validator(type({ batchId: "string.uuid" }))
	.handler(async ({ data }) => {
		await undoBatch(getDb(), data.batchId);
	});

export type ProductRow = Awaited<ReturnType<typeof listProducts>>[number];
export type ProductDetail = Awaited<ReturnType<typeof getProductDetail>>;
