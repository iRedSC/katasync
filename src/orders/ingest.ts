import { and, eq, inArray, sql } from "drizzle-orm";
import type { StockLocations } from "#/channels/stores";
import type { Db } from "#/db/client";
import {
	listings,
	movements,
	orderLines,
	orders,
	productAliases,
	productComponents,
	products,
	stores,
} from "#/db/schema";
import { readQuantityMode } from "#/inventory/commitments";
import { undoBatch } from "#/inventory/ledger";
import { batchProductIds, lockRecipes } from "#/inventory/ledger/post";
import { commitmentProductIds, syncLineStock, takeLineStock } from "./stock-effects";
import { type OrderTax, saveTax } from "./tax";

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
	// Rung up at our retail store (Shopify POS), so its stock comes off the
	// POS location's shelf (locations.posPrimary).
	soldInStore: boolean;
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
	tax: OrderTax;
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

type OrderLine = typeof orderLines.$inferSelect;
type ChannelLine = ChannelOrder["lines"][number];

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
	from: StockLocations,
): Promise<{ orderId: number; problems: string[] }> {
	return db.transaction(async (tx) => {
		const { lines, tax, ...fields } = order;
		const [saved] = await tx
			.insert(orders)
			.values({ ...fields, storeId: store.id })
			.onConflictDoUpdate({
				target: [orders.storeId, orders.externalId],
				set: { ...fields, syncedAt: new Date() },
			})
			.returning({ id: orders.id });
		await saveTax(tx, saved.id, tax);

		const problems: string[] = [];
		// When the store takes stock from, read now rather than trusted from the
		// caller: a sync pass reads its store once, and a cutover that moves the
		// date mid-pass (src/import/refresh.ts, which holds orders until it's
		// done) would otherwise have the pass take stock for orders from before
		// it.
		const [current] = await tx
			.select({ stockFrom: stores.stockFrom })
			.from(stores)
			.where(eq(stores.id, store.id));
		const takesStock = orderTakesStock(
			{ ...store, stockFrom: current?.stockFrom ?? null },
			order,
		);

		// The lines this order already has, read once for the pass.
		const savedLines = await tx
			.select()
			.from(orderLines)
			.where(eq(orderLines.orderId, saved.id));
		const existingLines = new Map(
			savedLines.map((row) => [row.externalId, row] as const),
		);
		// Only lines that need a product are looked up: new ones, and saved
		// ones not mapped yet. A mapped line keeps its product.
		const productOf = await resolveProducts(
			tx,
			store.id,
			lines.filter((line) => {
				const existing = existingLines.get(line.externalId);
				return existing ? existing.productId === null : line.quantity !== 0;
			}),
		);
		const roots = new Set(
			[...productOf.values()].flatMap((productId) =>
				productId === null ? [] : [productId],
			),
		);
		const saleBatches: string[] = [];
		for (const line of savedLines) {
			if (line.productId !== null) roots.add(line.productId);
			if (line.saleBatchId !== null) saleBatches.push(line.saleBatchId);
		}
		await readQuantityMode(tx);
		await lockRecipes(tx, [...roots], [
			...(await batchProductIds(tx, saleBatches)),
			...(await commitmentProductIds(
				tx,
				savedLines.map((line) => line.id),
			)),
		]);
		// Lines written or read back earlier in this pass. Their saved copy may
		// predate a stock take, so a repeat of one is read again, not trusted.
		const handled = new Set<string>();
		const costs = new Map<number, number | null>();
		const costOfOnce = async (productId: number) => {
			if (!costs.has(productId))
				costs.set(productId, await costOf(tx, productId));
			return costs.get(productId) ?? null;
		};

		for (const line of lines) {
			const existing = existingLines.get(line.externalId);
			// A line cancelled before we ever saw it has nothing to remember.
			if (!existing && line.quantity === 0) continue;
			// A line mapped after it came in picks up its product now.
			const productId = existing?.productId ?? productOf.get(line) ?? null;
			const unchanged =
				existing !== undefined &&
				!handled.has(line.externalId) &&
				existing.title === line.title &&
				existing.sku === line.sku &&
				existing.quantity === line.quantity &&
				existing.unitPrice === line.unitPrice &&
				existing.productId === productId;
			let row: OrderLine;
			if (unchanged) {
				row = existing;
			} else if (existing) {
				[row] = await tx
					.update(orderLines)
					.set({
						title: line.title,
						sku: line.sku,
						quantity: line.quantity,
						unitPrice: line.unitPrice,
						productId,
					})
					.where(eq(orderLines.id, existing.id))
					.returning();
				existingLines.set(line.externalId, row);
			} else {
				[row] = await tx
					.insert(orderLines)
					.values({
						...line,
						orderId: saved.id,
						productId,
						unitCost: productId === null ? null : await costOfOnce(productId),
					})
					.returning();
				existingLines.set(line.externalId, row);
			}
			handled.add(line.externalId);

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
			if (row.saleBatchId) continue;
			const problem = await syncLineStock(tx, {
				row,
				sku: line.sku,
				order,
				takesStock,
				from,
			});
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
	order: { name: string; soldInStore: boolean },
	from: StockLocations,
): Promise<string | null> {
	return takeLineStock(db, line, order, from);
}

// The listing mapping decides first. Without one, an exact SKU or alias match
// is enough, then the same SKU in other capitals ("FCI-Rad360" for
// "FCI-RAD360") when exactly one product has it, as listings match.
export async function resolveProduct(
	db: Db,
	storeId: number,
	line: ChannelOrder["lines"][number],
): Promise<number | null> {
	const found = await resolveProducts(db, storeId, [line]);
	return found.get(line) ?? null;
}

// resolveProduct for many lines at once: one query each for the listing
// mappings, SKUs, and aliases, instead of up to four per line. A line its
// listing matches never needs its SKU looked up.
async function resolveProducts(db: Db, storeId: number, lines: ChannelLine[]) {
	const listingIds = [
		...new Set(
			lines.flatMap((l) => (l.listingExternalId ? [l.listingExternalId] : [])),
		),
	];
	const byListing = new Map<string, number>();
	if (listingIds.length > 0) {
		const rows = await db
			.select({
				externalId: listings.externalId,
				productId: listings.productId,
			})
			.from(listings)
			.where(
				and(
					eq(listings.storeId, storeId),
					inArray(listings.externalId, listingIds),
				),
			);
		for (const row of rows) {
			if (row.productId !== null) byListing.set(row.externalId, row.productId);
		}
	}
	const skus = [
		...new Set(
			lines
				.filter(
					(l) => !(l.listingExternalId && byListing.has(l.listingExternalId)),
				)
				.flatMap((l) => (l.sku ? [l.sku] : [])),
		),
	];
	const bySku = new Map<string, number>();
	const byAlias = new Map<string, number>();
	if (skus.length > 0) {
		const skuRows = await db
			.select({ sku: products.sku, id: products.id })
			.from(products)
			.where(inArray(products.sku, skus));
		for (const row of skuRows) bySku.set(row.sku, row.id);
		const aliasRows = await db
			.select({ alias: productAliases.alias, id: productAliases.productId })
			.from(productAliases)
			.where(inArray(productAliases.alias, skus));
		for (const row of aliasRows) byAlias.set(row.alias, row.id);
	}
	const found = new Map<ChannelLine, number | null>();
	for (const line of lines) {
		const listed = line.listingExternalId
			? byListing.get(line.listingExternalId)
			: undefined;
		const exact = line.sku
			? (bySku.get(line.sku) ?? byAlias.get(line.sku))
			: undefined;
		found.set(
			line,
			listed ?? exact ?? (line.sku ? await bySkuCase(db, line.sku) : null),
		);
	}
	return found;
}

// The same SKU in other capitals, when exactly one product has it.
async function bySkuCase(db: Db, sku: string) {
	const byCase = await db
		.select({ id: products.id })
		.from(products)
		.where(sql`lower(${products.sku}) = lower(trim(${sku}))`)
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
