import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
	archiveShopifyVariant,
	deleteShopifyVariant,
} from "#/channels/shopify/refurbish";
import type { Db } from "#/db/client";
import {
	listings,
	locations,
	movements,
	products,
	stockLevels,
	stores,
} from "#/db/schema";
import { isOurs } from "#/inventory/locations";
import { archiveProduct, listingEnded } from "#/products/archive";

// A refurbished one-off is retired once none is left on our shelves: sold
// out, it's archived in Shopify and here; never sold (its return undone),
// its Shopify draft is deleted and it's archived here, as if never made.
// Shopify goes first, so katasync never hides a product still for sale.
// Every sync pass sweeps them all (src/channels/sync.ts), so one that
// failed is tried again; undoing a return retires its refurb at once.
// Returns what couldn't be retired, and why.
export async function retireRefurbs(
	db: Db,
	only?: number[],
): Promise<{ problems: string[] }> {
	if (only?.length === 0) return { problems: [] };
	const problems: string[] = [];
	for (const { id, sku } of await emptyRefurbs(db, only)) {
		try {
			await db.transaction(async (tx) => {
				// Locked as every stock movement locks it (lockStockProducts), then
				// checked again in a fresh read: stock that came back since (a
				// return restocked) keeps it for sale. The lock holds through
				// Shopify, so none can come back while it's retired.
				await tx
					.select({ id: products.id })
					.from(products)
					.where(eq(products.id, id))
					.for("update");
				const [refurb] = await emptyRefurbs(tx, [id]);
				if (!refurb) return;
				const live = await tx
					.select({ id: listings.id, externalId: listings.externalId })
					.from(listings)
					.innerJoin(stores, eq(stores.id, listings.storeId))
					.where(
						and(
							eq(listings.productId, refurb.id),
							eq(stores.channel, "shopify"),
							sql`not ${listingEnded}`,
						),
					);
				for (const listing of live) {
					if (refurb.sold) await archiveShopifyVariant(listing.externalId);
					else await deleteShopifyVariant(listing.externalId);
					await tx
						.update(listings)
						.set({ status: refurb.sold ? "ARCHIVED" : "DELETED" })
						.where(eq(listings.id, listing.id));
				}
				await archiveProduct(tx, refurb.sku);
			});
		} catch (error) {
			problems.push(
				`Refurb ${sku} couldn't be retired: ${error instanceof Error ? error.message : error}`,
			);
		}
	}
	return { problems };
}

// Refurbs still carried with none on our shelves, and whether each ever sold.
function emptyRefurbs(db: Db, only?: number[]) {
	const onHand = db
		.select({ one: sql`1` })
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(
			and(
				// Named: in a one-table select Drizzle leaves the table off, and
				// "id" would be the location's.
				sql`${stockLevels.productId} = "products"."id"`,
				isOurs,
				sql`${stockLevels.onHand} <> 0`,
			),
		);
	return db
		.select({
			id: products.id,
			sku: products.sku,
			sold: sql<boolean>`exists (select 1 from ${movements} where ${movements.productId} = "products"."id" and ${movements.reason} = 'sale')`,
		})
		.from(products)
		.where(
			and(
				isNotNull(products.refurbishedFromId),
				isNull(products.archivedAt),
				sql`not exists ${onHand}`,
				only ? inArray(products.id, only) : undefined,
			),
		);
}
