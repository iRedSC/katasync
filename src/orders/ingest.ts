import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	listings,
	movements,
	orderLines,
	orders,
	productAliases,
	productComponents,
	products,
} from "#/db/schema";
import { LedgerError, recordSale, undoBatch } from "#/inventory/ledger";

// An order as any channel adapter hands it over. Money is in store currency.
export type ChannelOrder = {
	externalId: string;
	name: string;
	salesChannel: string | null;
	marketplaceOrderId: string | null;
	placedAt: Date;
	cancelledAt: Date | null;
	// Shopify's words, which other channels map onto: UNFULFILLED,
	// PARTIALLY_FULFILLED, FULFILLED, FULFILLMENT_NOT_REQUIRED, ON_HOLD.
	fulfillmentStatus: string;
	// The marketplace ships it from its own stock (Amazon FBA). It never takes
	// stock here: FBA quantities mirror what Amazon reports.
	fulfilledByChannel: boolean;
	financialStatus: string | null;
	customerName: string | null;
	shipCity: string | null;
	shipRegion: string | null;
	shipCountry: string | null;
	total: number;
	shippingCharged: number;
	sourceUpdatedAt: Date;
	lines: {
		externalId: string;
		listingExternalId: string | null;
		sku: string | null;
		title: string;
		quantity: number;
		unitPrice: number;
	}[];
};

export type IngestStore = { id: number; stockFrom: Date | null };

// Saves an order and keeps stock in step with it, safely re-runnable:
// - Lines on orders placed at or after the store's stockFrom take stock once,
//   recorded on the line so a re-sync never takes it again.
// - A cancelled order gives back exactly what its lines took.
// - Lines that can't be matched to a product are saved without moving stock
//   and reported, so one unknown SKU doesn't stop the sync. Lines with no
//   SKU are custom items and aren't reported.
export async function ingestOrder(
	db: Db,
	store: IngestStore,
	order: ChannelOrder,
	locationId: number | null,
): Promise<{ orderId: number; problems: string[] }> {
	return db.transaction(async (tx) => {
		const { lines, ...fields } = order;
		const [saved] = await tx
			.insert(orders)
			.values({ ...fields, storeId: store.id })
			.onConflictDoUpdate({
				target: [orders.storeId, orders.externalId],
				set: { ...fields, syncedAt: new Date() },
			})
			.returning({ id: orders.id });

		const problems: string[] = [];
		const takesStock =
			!order.fulfilledByChannel &&
			store.stockFrom !== null &&
			order.placedAt >= store.stockFrom &&
			order.cancelledAt === null;

		for (const line of lines) {
			const productId = await resolveProduct(tx, store.id, line);
			const [existing] = await tx
				.select()
				.from(orderLines)
				.where(
					and(
						eq(orderLines.orderId, saved.id),
						eq(orderLines.externalId, line.externalId),
					),
				);
			const [row] = existing
				? await tx
						.update(orderLines)
						.set({
							title: line.title,
							sku: line.sku,
							quantity: line.quantity,
							unitPrice: line.unitPrice,
							// A line mapped after it came in picks up its product now.
							productId: existing.productId ?? productId,
						})
						.where(eq(orderLines.id, existing.id))
						.returning()
				: await tx
						.insert(orderLines)
						.values({
							...line,
							orderId: saved.id,
							productId,
							unitCost: productId === null ? null : await costOf(tx, productId),
						})
						.returning();

			if (order.cancelledAt !== null && row.saleBatchId) {
				if (!(await isUndone(tx, row.saleBatchId))) {
					await undoBatch(tx, row.saleBatchId);
				}
				continue;
			}
			if (!takesStock || row.saleBatchId) continue;
			if (row.productId === null) {
				// No SKU means a custom item (a one-off charge, a special order):
				// nothing to take from stock, nothing to flag.
				if (line.sku !== null) {
					problems.push(`${order.name}: no product for ${line.sku}`);
				}
				continue;
			}
			if (locationId === null) {
				problems.push(`${order.name}: no location to take stock from`);
				continue;
			}
			try {
				const sale = await recordSale(tx, {
					productId: row.productId,
					quantity: row.quantity,
					locationId,
					reference: `order:${saved.id}:${row.id}`,
				});
				await tx
					.update(orderLines)
					.set({ saleBatchId: sale.batchId })
					.where(eq(orderLines.id, row.id));
			} catch (error) {
				if (!(error instanceof LedgerError)) throw error;
				problems.push(`${order.name}: ${error.message}`);
			}
		}
		return { orderId: saved.id, problems };
	});
}

// The listing mapping decides first. Before listings have synced, an exact SKU
// or alias match is enough.
async function resolveProduct(
	db: Db,
	storeId: number,
	line: ChannelOrder["lines"][number],
): Promise<number | null> {
	if (line.listingExternalId) {
		const [listing] = await db
			.select({ productId: listings.productId })
			.from(listings)
			.where(
				and(
					eq(listings.storeId, storeId),
					eq(listings.externalId, line.listingExternalId),
				),
			);
		if (listing?.productId) return listing.productId;
	}
	if (!line.sku) return null;
	const [bySku] = await db
		.select({ id: products.id })
		.from(products)
		.where(eq(products.sku, line.sku));
	if (bySku) return bySku.id;
	const [byAlias] = await db
		.select({ id: productAliases.productId })
		.from(productAliases)
		.where(eq(productAliases.alias, line.sku));
	return byAlias?.id ?? null;
}

// Cost of one unit right now. A bundle costs the sum of its parts; unknown if
// any part has no cost.
async function costOf(db: Db, productId: number): Promise<number | null> {
	const [product] = await db
		.select({ kind: products.kind, unitCost: products.unitCost })
		.from(products)
		.where(eq(products.id, productId));
	if (!product) return null;
	if (product.kind !== "bundle") return product.unitCost;
	const parts = await db
		.select({
			quantity: productComponents.quantity,
			unitCost: products.unitCost,
		})
		.from(productComponents)
		.innerJoin(products, eq(products.id, productComponents.componentProductId))
		.where(eq(productComponents.parentProductId, productId));
	if (parts.length === 0 || parts.some((p) => p.unitCost === null)) return null;
	return parts.reduce((sum, p) => sum + (p.unitCost ?? 0) * p.quantity, 0);
}

async function isUndone(db: Db, batchId: string) {
	const [undo] = await db
		.select({ id: movements.id })
		.from(movements)
		.where(eq(movements.reference, `undo:${batchId}`))
		.limit(1);
	return Boolean(undo);
}
