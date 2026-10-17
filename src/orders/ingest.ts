import { and, eq, sql } from "drizzle-orm";
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
	// PARTIALLY_FULFILLED, FULFILLED, FULFILLMENT_NOT_REQUIRED, ON_HOLD. Plus
	// AWAITING_PAYMENT for Amazon's Pending, which must not ship yet.
	fulfillmentStatus: string;
	// The marketplace ships it from its own stock (Amazon FBA). It never takes
	// stock here: FBA quantities mirror what Amazon reports.
	fulfilledByChannel: boolean;
	financialStatus: string | null;
	customerName: string | null;
	shipAddress1: string | null;
	shipAddress2: string | null;
	shipCity: string | null;
	shipRegion: string | null;
	shipPostalCode: string | null;
	shipCountry: string | null;
	shipPhone: string | null;
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
// - A cancelled order gives back exactly what its lines took, and a line
//   whose quantity changed gives it back and takes the new quantity. A line's
//   quantity is what leaves our stock: units cancelled before shipping don't
//   count, units refunded after shipping still do (they come back as a
//   return). Channels report a fully cancelled line with quantity 0 rather
//   than dropping it.
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
		const takesStock = orderTakesStock(store, order);

		for (const line of lines) {
			const [existing] = await tx
				.select()
				.from(orderLines)
				.where(
					and(
						eq(orderLines.orderId, saved.id),
						eq(orderLines.externalId, line.externalId),
					),
				);
			// A line cancelled before we ever saw it has nothing to remember.
			if (!existing && line.quantity === 0) continue;
			const productId = await resolveProduct(tx, store.id, line);
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
			// A quantity that changed after the line took stock (a unit cancelled
			// on the channel) gives that stock back, then the line takes what's
			// left below.
			if (row.saleBatchId && existing && existing.quantity !== line.quantity) {
				if (!(await isUndone(tx, row.saleBatchId))) {
					await undoBatch(tx, row.saleBatchId);
				}
				await tx
					.update(orderLines)
					.set({ saleBatchId: null })
					.where(eq(orderLines.id, row.id));
				row.saleBatchId = null;
			}
			if (!takesStock || row.saleBatchId || row.quantity === 0) continue;
			if (row.productId === null) {
				// No SKU means a custom item (a one-off charge, a special order):
				// nothing to take from stock, nothing to flag.
				if (line.sku !== null) {
					problems.push(`${order.name}: no product for ${line.sku}`);
				}
				continue;
			}
			const problem = await takeStock(
				tx,
				{ ...row, productId: row.productId },
				order.name,
				locationId,
			);
			if (problem) problems.push(problem);
		}
		return { orderId: saved.id, problems };
	});
}

// Whether an order's lines take stock: placed after the store started
// tracking stock, not cancelled, and shipped by us rather than the marketplace.
export function orderTakesStock(
	store: IngestStore,
	order: Pick<ChannelOrder, "fulfilledByChannel" | "placedAt" | "cancelledAt">,
) {
	return (
		!order.fulfilledByChannel &&
		store.stockFrom !== null &&
		order.placedAt >= store.stockFrom &&
		order.cancelledAt === null
	);
}

// Takes one line's stock and remembers the movement on the line, so it's
// never taken twice. Returns a problem to report instead of throwing for
// ledger rule failures, so one bad line doesn't stop the rest.
export async function takeStock(
	db: Db,
	line: { id: number; orderId: number; productId: number; quantity: number },
	orderName: string,
	locationId: number | null,
): Promise<string | null> {
	if (locationId === null)
		return `${orderName}: no location to take stock from`;
	try {
		const sale = await recordSale(db, {
			productId: line.productId,
			quantity: line.quantity,
			locationId,
			reference: `order:${line.orderId}:${line.id}`,
		});
		await db
			.update(orderLines)
			.set({ saleBatchId: sale.batchId })
			.where(eq(orderLines.id, line.id));
		return null;
	} catch (error) {
		if (!(error instanceof LedgerError)) throw error;
		return `${orderName}: ${error.message}`;
	}
}

// The listing mapping decides first. Without one, an exact SKU or alias match
// is enough, then the same SKU in other capitals ("FCI-Rad360" for
// "FCI-RAD360") when exactly one product has it, as listings match.
export async function resolveProduct(
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
	if (byAlias) return byAlias.id;
	const byCase = await db
		.select({ id: products.id })
		.from(products)
		.where(sql`lower(${products.sku}) = lower(trim(${line.sku}))`)
		.limit(2);
	return byCase.length === 1 ? byCase[0].id : null;
}

// Cost of one unit right now. A bundle costs the sum of its parts; unknown if
// any part has no cost.
export async function costOf(
	db: Db,
	productId: number,
): Promise<number | null> {
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
