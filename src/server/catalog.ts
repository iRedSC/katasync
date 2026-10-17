import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { matchListings } from "#/channels/listings";
import { shippingLocation } from "#/channels/stores";
import { type Db, getDb } from "#/db/client";
import {
	listings,
	locations,
	movements,
	orderLines,
	orders,
	productAliases,
	productComponents,
	productGroups,
	productSuppliers,
	products,
	stockLevels,
	stores,
	suppliers,
} from "#/db/schema";
import { abcClasses } from "#/inventory/abc";
import { getAvailability, getBundleBlockers } from "#/inventory/availability";
import {
	cancelCountRequests,
	recordCount as recordShelfCount,
	requestCounts,
	undoBatch,
} from "#/inventory/ledger";
import {
	defaultMinStock,
	defaultRanges,
	setDefaultMinStock,
	setProductStockRange,
	stockRanges,
} from "#/inventory/stock-range";
import {
	applyListingsToOrders,
	matchListing as matchListingToSku,
	productFromListing,
} from "#/orders/remap";
import { purchaseOrderOfBatch } from "#/purchasing/orders";
import {
	aItemsAtRisk,
	draftLines,
	loadPlan,
	needsOf,
	reorderBreakdown,
	unitsOnOrder,
} from "#/purchasing/reorder";
import { setSuppliers } from "#/purchasing/suppliers";

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
				supplierId: suppliers.id,
				supplierName: suppliers.name,
			})
			.from(products)
			.leftJoin(productGroups, eq(productGroups.id, products.groupId))
			.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
			.leftJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.orderBy(products.name, products.variantName);
		const ranked = abcClasses(db);
		const plan = loadPlan(db, new Date(), ranked);
		const ids = rows.map((r) => r.id);
		const [
			available,
			onHandRows,
			filing,
			abc,
			onOrder,
			drafts,
			breakdown,
			shelves,
			ranges,
			planned,
			components,
			setSupplier,
		] = await Promise.all([
			ownedLocationIds().then((owned) => getAvailability(db, ids, owned)),
			db
				.select({
					productId: stockLevels.productId,
					onHand: sql<number>`sum(${stockLevels.onHand})::int`,
				})
				.from(stockLevels)
				.innerJoin(locations, eq(locations.id, stockLevels.locationId))
				.where(eq(locations.kind, "owned"))
				.groupBy(stockLevels.productId),
			db
				.select({
					productId: listings.productId,
					tags: listings.tags,
					productType: listings.productType,
					vendor: listings.vendor,
					status: listings.status,
				})
				.from(listings)
				.innerJoin(stores, eq(stores.id, listings.storeId))
				.where(
					and(eq(stores.channel, "shopify"), isNotNull(listings.productId)),
				),
			ranked,
			unitsOnOrder(db),
			draftLines(db),
			reorderBreakdown(db, { plan }),
			// Counts across our own shelves: the oldest, null when any shelf
			// was never counted, and whether one is waiting to be counted.
			db
				.select({
					productId: stockLevels.productId,
					oldest:
						sql<Date | null>`case when bool_or(${stockLevels.lastCountedAt} is null) then null else min(${stockLevels.lastCountedAt}) end`.mapWith(
							(v: string | Date | null) => (v === null ? null : new Date(v)),
						),
					requested: sql<boolean>`bool_or(${countDue})`,
				})
				.from(stockLevels)
				.innerJoin(locations, eq(locations.id, stockLevels.locationId))
				.where(eq(locations.kind, "owned"))
				.groupBy(stockLevels.productId),
			stockRanges(db, ids, plan),
			plan,
			db
				.select({
					setId: productComponents.parentProductId,
					partId: productComponents.componentProductId,
				})
				.from(productComponents),
			setSuppliers(db),
		]);
		const counted = new Map(shelves.map((s) => [s.productId, s]));
		const onHand = new Map(onHandRows.map((r) => [r.productId, r.onHand]));
		const need = new Map(needsOf(breakdown).map((n) => [n.productId, n]));
		const why = new Map(breakdown.map((b) => [b.line.productId, b.why]));
		const shopify = shopifyFiling(filing);
		const listed = rows.map(({ supplierId, supplierName, ...r }) => {
			const s = shopify.get(r.id);
			const c = abc.classes.get(r.id);
			const n = need.get(r.id);
			const range = ranges.get(r.id);
			// stockRanges answers for every product it's asked about.
			if (!range) throw new Error(`No stock range for ${r.sku}`);
			return {
				...r,
				// Our own type wins; Shopify's fills in where we have none.
				category: r.category ?? s?.productType ?? null,
				tags: s ? [...s.tags].sort() : [],
				vendor: s?.vendor ?? null,
				status: s?.status ?? null,
				onHand: r.kind === "bundle" ? null : (onHand.get(r.id) ?? 0),
				available: available.get(r.id) ?? 0,
				abc: c?.abc ?? null,
				// 1 is the most value. Null for tool sets and unpriced products.
				abcRank: c?.rank ?? null,
				supplier:
					supplierId === null || supplierName === null
						? null
						: { id: supplierId, name: supplierName },
				// Units on sent POs that haven't arrived.
				onOrder: onOrder.get(r.id) ?? 0,
				// Its line on the supplier's open draft, in the line's unit.
				draft: drafts.get(r.id) ?? null,
				// What to order today, in the supplier's unit. Null when stock
				// and what's on order last until a PO sent now would arrive.
				reorder: n
					? {
							quantity: n.quantity,
							unit: n.unit,
							packSize: n.packSize,
							supplierCount: n.supplierCount,
						}
					: null,
				// How much we like to keep, its own or the defaults.
				range,
				// The oldest count across our shelves; null if any never was.
				lastCountedAt: counted.get(r.id)?.oldest ?? null,
				countRequested: counted.get(r.id)?.requested ?? false,
				// Units a day over the reorder window, as reorder sizes them.
				dailyDemand: planned.forecasts.get(r.id)?.dailyDemand ?? 0,
				// Why reorder wants what it does, for the velocity gauge. Null for
				// tool sets, which are ordered as their parts.
				why: r.kind === "bundle" ? null : (why.get(r.id) ?? null),
			};
		});
		// A tool set reads like any product: its class from its own sales
		// (abc.sets), counted once all its parts are, ordered from the supplier
		// of most of its parts, one at a time once none can be built.
		const byId = new Map(listed.map((p) => [p.id, p]));
		const partsOf = new Map<number, number[]>();
		for (const c of components)
			partsOf.set(c.setId, [...(partsOf.get(c.setId) ?? []), c.partId]);
		return {
			products: listed.map((p) => {
				if (p.kind !== "bundle") return p;
				const parts = (partsOf.get(p.id) ?? []).flatMap((id) => {
					const part = byId.get(id);
					return part ? [part] : [];
				});
				const counts = parts.map((part) => part.lastCountedAt);
				const supplier = setSupplier.get(p.id) ?? null;
				const c = abc.sets.get(p.id);
				return {
					...p,
					abc: c?.abc ?? null,
					abcRank: c?.rank ?? null,
					lastCountedAt:
						counts.length === 0 || counts.some((at) => at === null)
							? null
							: new Date(Math.min(...counts.map((at) => at?.getTime() ?? 0))),
					countRequested: parts.some((part) => part.countRequested),
					supplier,
					reorder:
						p.available === 0 && supplier
							? { quantity: 1, unit: "EACH", packSize: 1, supplierCount: 1 }
							: null,
				};
			}),
			abcDays: abc.days,
			unpriced: abc.unpriced,
		};
	},
);

// A product can sell through several Shopify listings (variants, or a second
// store). Tags are pooled; for status, the most visible listing wins, so a
// product that's live anywhere reads as active.
const STATUS_RANK = ["ACTIVE", "DRAFT", "ARCHIVED"];
function shopifyFiling(
	rows: {
		productId: number | null;
		tags: string[];
		productType: string | null;
		vendor: string | null;
		status: string | null;
	}[],
) {
	const byProduct = new Map<
		number,
		{
			tags: Set<string>;
			productType: string | null;
			vendor: string | null;
			status: string | null;
		}
	>();
	// Unknown statuses (Shopify adds them now and then) rank after the known ones.
	const rank = (s: string | null) => {
		if (s === null) return Infinity;
		const i = STATUS_RANK.indexOf(s);
		return i === -1 ? STATUS_RANK.length : i;
	};
	for (const row of rows) {
		if (row.productId === null) continue;
		const f = byProduct.get(row.productId) ?? {
			tags: new Set<string>(),
			productType: null,
			vendor: null,
			status: null,
		};
		for (const tag of row.tags) f.tags.add(tag);
		f.productType ??= row.productType;
		f.vendor ??= row.vendor;
		if (rank(row.status) < rank(f.status)) f.status = row.status;
		byProduct.set(row.productId, f);
	}
	return byProduct;
}

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
					kind: products.kind,
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
			owned,
		]);

		// The product and its parts in one availability lookup.
		const [availability, abc] = await Promise.all([
			getAvailability(
				db,
				[product.id, ...components.map((c) => c.id)],
				ownedLocations.map((l) => l.id),
			),
			abcClasses(db),
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
			stock,
			aliases: aliases.map((a) => a.alias),
			listings: productListings,
			history,
			available: availability.get(product.id) ?? 0,
			abc: rank ? { ...rank, of: ranking.size, days: abc.days } : null,
			// Where a count could be recorded. One location means nobody has to pick.
			locations: ownedLocations,
		};
	});

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
				.where(lt(stockLevels.onHand, 0))
				.orderBy(stockLevels.onHand),
			ownedLocationIds().then((owned) => getBundleBlockers(db, owned)),
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

// Makes one store the primary (or none, with id null), then lets its
// unmatched listings become products right away instead of on the next sync.
export const setPrimaryStore = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0 | null" }))
	.handler(async ({ data }) => {
		const db = getDb();
		await db.transaction(async (tx) => {
			await tx
				.update(stores)
				.set({ primary: false })
				.where(eq(stores.primary, true));
			if (data.id) {
				await tx
					.update(stores)
					.set({ primary: true })
					.where(eq(stores.id, data.id));
			}
		});
		if (!data.id) return { created: 0, skipped: [] as string[] };
		const matched = await matchListings(db);
		await applyListingsToOrders(db, matched.mapped, await shippingLocation(db));
		return { created: matched.created, skipped: matched.skipped };
	});

// Listings without a SKU are custom products and never need one.
const unmapped = sql`${listings.productId} is null and ${listings.externalSku} is not null`;

// Listings that need a product, most-sold first so the ones that matter come
// up top.
export const listUnmappedListings = createServerFn({ method: "GET" }).handler(
	async () => {
		const sold = getDb()
			.select({
				storeId: orders.storeId,
				listingExternalId: orderLines.listingExternalId,
				units: sql<number>`sum(${orderLines.quantity})::int`.as("units"),
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.groupBy(orders.storeId, orderLines.listingExternalId)
			.as("sold");
		return getDb()
			.select({
				id: listings.id,
				store: stores.name,
				channel: stores.channel,
				externalSku: listings.externalSku,
				title: listings.title,
				fulfillment: listings.fulfillment,
				unitsSold: sql<number>`coalesce(${sold.units}, 0)`,
			})
			.from(listings)
			.innerJoin(stores, eq(stores.id, listings.storeId))
			.leftJoin(
				sold,
				and(
					eq(sold.storeId, listings.storeId),
					eq(sold.listingExternalId, listings.externalId),
				),
			)
			.where(unmapped)
			.orderBy(sql`coalesce(${sold.units}, 0) desc`, listings.title);
	},
);

export async function countUnmappedListings(db: Db) {
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(listings)
		.where(unmapped);
	return count;
}

// Matches a listing to an existing product, then catches up past orders.
export const matchListing = createServerFn({ method: "POST" })
	.validator(type({ listingId: "number.integer > 0", sku: "string > 0" }))
	.handler(async ({ data }) =>
		matchListingToSku(getDb(), data.listingId, data.sku),
	);

// Creates the product a listing is selling, filled in from the listing.
export const createListingProduct = createServerFn({ method: "POST" })
	.validator(type({ listingId: "number.integer > 0" }))
	.handler(async ({ data }) => productFromListing(getDb(), data.listingId));

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
		const db = getDb();
		// A PO receipt undone here would leave the PO thinking it arrived.
		const po = await purchaseOrderOfBatch(db, data.batchId);
		if (po !== null) throw new Error(`Undo this on PO ${po}.`);
		await undoBatch(db, data.batchId);
	});

// A shelf is due once someone asks for a count, until a count lands after
// the request.
const countDue = and(
	isNotNull(stockLevels.countRequestedAt),
	sql`(${stockLevels.lastCountedAt} is null or ${stockLevels.lastCountedAt} < ${stockLevels.countRequestedAt})`,
	eq(locations.kind, "owned"),
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
// first one when none holds it yet.
async function requestShelfCounts(db: Db, productId: number) {
	const [held, owned] = await Promise.all([
		db
			.select({ locationId: stockLevels.locationId })
			.from(stockLevels)
			.innerJoin(locations, eq(locations.id, stockLevels.locationId))
			.where(
				and(eq(stockLevels.productId, productId), eq(locations.kind, "owned")),
			),
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

export type ProductRow = Awaited<
	ReturnType<typeof listProducts>
>["products"][number];
export type ProductDetail = Awaited<ReturnType<typeof getProductDetail>>;

// Quick ship asks about insurance for any order holding this product.
export const setInsureWhenShipped = createServerFn({ method: "POST" })
	.validator(type({ sku: "string > 0", insure: "boolean" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(products)
			.set({ insureWhenShipped: data.insure })
			.where(eq(products.sku, data.sku));
	});

// Critical products count toward their supplier's criticalThreshold when they
// need ordering (see purchasing/reorder.ts).
export const setCritical = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0", critical: "boolean" }))
	.handler(async ({ data }) => {
		await getDb()
			.update(products)
			.set({ critical: data.critical })
			.where(eq(products.id, data.productId));
	});

// The min products use until they get their own range.
export const getDefaultMinStock = createServerFn({ method: "GET" }).handler(
	async () => defaultMinStock(getDb()),
);

export const saveDefaultMinStock = createServerFn({ method: "POST" })
	.validator(type({ min: "number.integer >= 0" }))
	.handler(async ({ data }) => setDefaultMinStock(getDb(), data.min));

// The range a product falls back on: min from settings, max from its sales.
export const getDefaultRange = createServerFn({ method: "GET" })
	.validator(type({ productId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const range = (await defaultRanges(getDb(), [data.productId])).get(
			data.productId,
		);
		if (!range) throw new Error(`No product ${data.productId}`);
		return range;
	});

const range = type({ min: "number.integer >= 0", max: "number.integer > 0" });

// range null puts the product back on the defaults.
export const saveProductStockRange = createServerFn({ method: "POST" })
	.validator(type({ productId: "number.integer > 0", range: range.or("null") }))
	.handler(async ({ data }) =>
		setProductStockRange(getDb(), data.productId, data.range),
	);
