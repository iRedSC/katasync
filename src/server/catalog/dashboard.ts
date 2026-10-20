import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { products, stockLevels } from "#/db/schema";
import { getBundleBlockers } from "#/inventory/availability";
import { onlineStock } from "#/inventory/online-stock";
import { aItemsAtRisk } from "#/purchasing/reorder";

// Home shows only what needs someone. Stock totals are deliberately absent:
// nobody acts on them.
export const getDashboard = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [oversold, blockers, [{ bundles }], atRisk] = await Promise.all([
			db
				.select({
					sku: products.sku,
					name: products.name,
					variantName: products.variantName,
					imageUrl: products.imageUrl,
					onHand: stockLevels.onHand,
				})
				.from(stockLevels)
				.innerJoin(products, eq(products.id, stockLevels.productId))
				// Not counted goes below zero by design until its count.
				.where(and(lt(stockLevels.onHand, 0), isNull(products.notCountedSince)))
				.orderBy(stockLevels.onHand),
			onlineStock(db).then((from) => getBundleBlockers(db, from)),
			db
				.select({ bundles: sql<number>`count(*)::int` })
				.from(products)
				.where(eq(products.kind, "bundle")),
			aItemsAtRisk(db),
		]);

		const top = blockers.slice(0, 6);
		const blockerProducts = new Map(
			(top.length === 0
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
						.where(
							inArray(
								products.id,
								top.map((b) => b.productId),
							),
						)
			).map((p) => [p.id, p]),
		);

		return {
			oversold,
			blockers: top.flatMap((b) => {
				const product = blockerProducts.get(b.productId);
				return product ? [{ ...product, blocks: b.blocks.length }] : [];
			}),
			blockedBundles: new Set(blockers.flatMap((b) => b.blocks)).size,
			bundles,
			atRisk,
		};
	},
);
