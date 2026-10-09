import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { desc, eq, lt, sql } from "drizzle-orm";
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
import { getAvailability } from "#/inventory/availability";
import { postMovements } from "#/inventory/ledger";

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
		const available = await getAvailability(
			db,
			rows.map((r) => r.id),
			await ownedLocationIds(),
		);
		const onHand = new Map(
			(
				await db
					.select({
						productId: stockLevels.productId,
						onHand: sql<number>`sum(${stockLevels.onHand})::int`,
					})
					.from(stockLevels)
					.innerJoin(locations, eq(locations.id, stockLevels.locationId))
					.where(eq(locations.kind, "owned"))
					.groupBy(stockLevels.productId)
			).map((r) => [r.productId, r.onHand]),
		);
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

		const [group] = product.groupId
			? await db
					.select()
					.from(productGroups)
					.where(eq(productGroups.id, product.groupId))
			: [];
		const variants = product.groupId
			? await db
					.select({
						sku: products.sku,
						variantName: products.variantName,
					})
					.from(products)
					.where(eq(products.groupId, product.groupId))
					.orderBy(products.variantName)
			: [];

		const components = await db
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
			.where(eq(productComponents.parentProductId, product.id));
		const componentAvailability = await getAvailability(
			db,
			components.map((c) => c.id),
			await ownedLocationIds(),
		);

		const usedIn = await db
			.select({
				sku: products.sku,
				name: products.name,
				quantity: productComponents.quantity,
			})
			.from(productComponents)
			.innerJoin(products, eq(products.id, productComponents.parentProductId))
			.where(eq(productComponents.componentProductId, product.id))
			.orderBy(products.sku);

		const stock = await db
			.select({
				location: locations.name,
				kind: locations.kind,
				onHand: stockLevels.onHand,
			})
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(eq(stockLevels.productId, product.id))
			.orderBy(locations.name);

		const aliases = await db
			.select({ alias: productAliases.alias })
			.from(productAliases)
			.where(eq(productAliases.productId, product.id));

		const productListings = await db
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
			.where(eq(listings.productId, product.id));

		const history = await db
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
			.limit(50);

		const [available] = (
			await getAvailability(db, [product.id], await ownedLocationIds())
		).values();

		return {
			product,
			group: group ?? null,
			variants,
			components: components.map((c) => ({
				...c,
				available: componentAvailability.get(c.id) ?? 0,
			})),
			usedIn,
			stock,
			aliases: aliases.map((a) => a.alias),
			listings: productListings,
			history,
			available: available ?? 0,
		};
	});

export const getDashboard = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [counts] = await db
			.select({
				products: sql<number>`count(*)::int`,
				bundles: sql<number>`count(*) filter (where ${products.kind} = 'bundle')::int`,
			})
			.from(products);
		const [stock] = await db
			.select({
				units: sql<number>`coalesce(sum(greatest(${stockLevels.onHand}, 0)), 0)::int`,
				value: sql<number>`coalesce(sum(greatest(${stockLevels.onHand}, 0) * ${products.unitCost}), 0)::float`,
			})
			.from(stockLevels)
			.innerJoin(products, eq(products.id, stockLevels.productId));
		const oversold = await db
			.select({
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				onHand: stockLevels.onHand,
			})
			.from(stockLevels)
			.innerJoin(products, eq(products.id, stockLevels.productId))
			.where(lt(stockLevels.onHand, 0))
			.orderBy(stockLevels.onHand);
		const [unmapped] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(listings)
			.where(sql`${listings.productId} is null`);

		const bundleIds = (
			await db
				.select({ id: products.id })
				.from(products)
				.where(eq(products.kind, "bundle"))
		).map((b) => b.id);
		const bundleAvailability = await getAvailability(
			db,
			bundleIds,
			await ownedLocationIds(),
		);
		const bundlesOut = [...bundleAvailability.values()].filter(
			(v) => v === 0,
		).length;

		return {
			...counts,
			...stock,
			oversold,
			unmappedListings: unmapped.count,
			bundlesOut,
		};
	},
);

export const listMovements = createServerFn({ method: "GET" }).handler(
	async () => {
		return getDb()
			.select({
				id: movements.id,
				createdAt: movements.createdAt,
				sku: products.sku,
				name: products.name,
				location: locations.name,
				delta: movements.delta,
				reason: movements.reason,
				reference: movements.reference,
				note: movements.note,
			})
			.from(movements)
			.innerJoin(products, eq(products.id, movements.productId))
			.innerJoin(locations, eq(locations.id, movements.locationId))
			.orderBy(desc(movements.id))
			.limit(200);
	},
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

// A manual correction, e.g. after a cycle count. Recorded as an adjustment
// movement so the history explains the change.
export const adjustStock = createServerFn({ method: "POST" })
	.validator(
		type({
			sku: "string > 0",
			locationId: "number.integer > 0",
			delta: "number.integer",
			note: "string > 0",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [product] = await db
			.select({ id: products.id })
			.from(products)
			.where(eq(products.sku, data.sku));
		if (!product) throw new Error(`No product ${data.sku}`);
		const result = await postMovements(db, {
			note: data.note,
			lines: [
				{
					productId: product.id,
					locationId: data.locationId,
					delta: data.delta,
					reason: "adjustment",
				},
			],
		});
		return { onHand: result.levels[0].onHand };
	});

export type ProductRow = Awaited<ReturnType<typeof listProducts>>[number];
export type ProductDetail = Awaited<ReturnType<typeof getProductDetail>>;
