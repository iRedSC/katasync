import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { desc, eq, sql } from "drizzle-orm";
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
import { abcClasses } from "#/inventory/abc";
import { getAvailability } from "#/inventory/availability";
import { isOurs } from "#/inventory/locations";
import { onlineStock } from "#/inventory/online-stock";
import { membershipOf } from "#/purchasing/reorder";

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
		// Warehouse first, so it's the one picked unless someone picks another.
		const ours = db
			.select({ id: locations.id, name: locations.name, kind: locations.kind })
			.from(locations)
			.where(isOurs)
			.orderBy(locations.kind, locations.name);
		const [
			group,
			variants,
			components,
			usedIn,
			stock,
			aliases,
			productListings,
			history,
			ourLocations,
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
					notCounted: sql<boolean>`${products.notCountedSince} is not null`,
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
					kind: products.kind,
					variantName: products.variantName,
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
					tags: listings.tags,
					productType: listings.productType,
					vendor: listings.vendor,
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
			ours,
		]);

		// The product and its parts in one availability lookup.
		const online = await onlineStock(db);
		const [availability, abc, sets] = await Promise.all([
			getAvailability(db, [product.id, ...components.map((c) => c.id)], online),
			abcClasses(db),
			membershipOf(db, product.id),
		]);
		// Tool sets rank among themselves (see AbcResult.sets).
		const ranking = product.kind === "bundle" ? abc.sets : abc.classes;
		const rank = ranking.get(product.id);

		return {
			product,
			group,
			variants,
			components: components.map((c) => ({
				...c,
				available: availability.get(c.id) ?? 0,
			})),
			usedIn,
			sets,
			stock,
			aliases: aliases.map((a) => a.alias),
			listings: productListings,
			history,
			available: availability.get(product.id) ?? 0,
			abc: rank ? { ...rank, of: ranking.size, days: abc.days } : null,
			// Where a count or transfer could be recorded. One location means
			// nobody has to pick.
			locations: ourLocations,
			// How the page works out what's sellable after a count or move.
			online,
		};
	});

export type ProductDetail = Awaited<ReturnType<typeof getProductDetail>>;
