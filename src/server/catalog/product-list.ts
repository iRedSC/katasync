import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import {
	listings,
	locations,
	productComponents,
	productGroups,
	productSuppliers,
	products,
	stockLevels,
	stores,
	suppliers,
} from "#/db/schema";
import { abcClasses } from "#/inventory/abc";
import { getAvailability } from "#/inventory/availability";
import { stockRanges } from "#/inventory/stock-range";
import {
	draftLines,
	loadPlan,
	needsOf,
	reorderBreakdown,
	unitsOnOrder,
} from "#/purchasing/reorder";
import { setSuppliers } from "#/purchasing/suppliers";
import { ownedLocationIds } from "./owned-locations";
import { countDue } from "./shelf-counts";

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

export type ProductRow = Awaited<
	ReturnType<typeof listProducts>
>["products"][number];
