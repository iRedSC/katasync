import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import {
	catalogs,
	listings,
	locations,
	productComponents,
	productGroups,
	products,
	stockLevels,
	stores,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { abcClasses } from "#/inventory/abc";
import { getAvailability } from "#/inventory/availability";
import { countDue } from "#/inventory/counts-due";
import { isOurs } from "#/inventory/locations";
import { onlineStock } from "#/inventory/online-stock";
import { stockRanges } from "#/inventory/stock-range";
import { carriedOrStocked } from "#/products/archive";
import {
	draftLines,
	loadPlan,
	needsOf,
	reorderBreakdown,
	unitsOnOrder,
} from "#/purchasing/reorder";
import { setSuppliers } from "#/purchasing/suppliers";
import { shopifyFiling } from "./shopify-filing";

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
				// Shown only while some is still on our shelves.
				archived: sql<boolean>`${products.archivedAt} is not null`,
				// Sells without limit until its first count; for a tool set, when
				// any part does (src/inventory/not-counted.ts).
				notCounted: sql<boolean>`${products.notCountedSince} is not null`,
				group: productGroups.name,
				catalogId: catalogs.id,
				catalogName: catalogs.name,
				catalogPhotoId: catalogs.photoId,
				supplierId: suppliers.id,
				supplierName: suppliers.name,
			})
			.from(products)
			.leftJoin(productGroups, eq(productGroups.id, products.groupId))
			.leftJoin(catalogs, eq(catalogs.id, products.catalogId))
			// Who reorder buys it from: its cheapest supplier.
			.leftJoin(
				supplierOffers,
				and(
					eq(supplierOffers.productId, products.id),
					eq(supplierOffers.cheapest, true),
				),
			)
			.leftJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
			.where(carriedOrStocked)
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
			onlineStock(db).then((from) => getAvailability(db, ids, from)),
			db
				.select({
					productId: stockLevels.productId,
					onHand: sql<number>`sum(${stockLevels.onHand})::int`,
				})
				.from(stockLevels)
				.innerJoin(locations, eq(locations.id, stockLevels.locationId))
				.where(isOurs)
				.groupBy(stockLevels.productId),
			db
				.select({
					productId: listings.productId,
					tags: listings.tags,
					productType: listings.productType,
					vendor: listings.vendor,
					status: listings.status,
					goneAt: listings.goneAt,
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
				.where(isOurs)
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
		const listed = rows.map(
			({
				supplierId,
				supplierName,
				catalogId,
				catalogName,
				catalogPhotoId,
				...r
			}) => {
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
					// The line it's sold in, which says who sells it.
					catalog:
						catalogId === null || catalogName === null
							? null
							: { id: catalogId, name: catalogName, photoId: catalogPhotoId },
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
			},
		);
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
					notCounted: parts.some((part) => part.notCounted),
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

export type ProductRow = Awaited<
	ReturnType<typeof listProducts>
>["products"][number];
