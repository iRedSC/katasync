import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { shippingLocation } from "#/channels/stores";
import type { Db } from "#/db/client";
import {
	locations,
	orderLines,
	orderReturns,
	orders,
	productAliases,
	productGroups,
	products,
	stores,
} from "#/db/schema";
import { postMovements, requestCounts } from "#/inventory/ledger";
import { markNotCounted } from "#/inventory/not-counted";
import { setRecipe } from "#/inventory/recipes";
import { takeStock } from "#/orders/ingest";
import type { ImportPlan } from "./sumtracker";

// Cutover from Sumtracker onto a database that's already in use. Sumtracker
// owns stock, costs, and the catalog's details; katasync owns orders,
// shipments, boxes, returns, matches, and everything else. So this starts
// stock over from the export and refreshes the products it lists by SKU,
// leaving everything else where it is:
//
// - Stock: the whole ledger, every count, and every PO (none were real) are
//   wiped. Stock starts again from the export as opening stock, and the sales
//   of orders placed since the export are taken again, so the ledger reads as
//   if katasync had tracked stock from the moment of the export.
// - Products: matched by SKU, keeping their ids so orders and listings stay
//   attached. The export fills in or changes their details but never blanks
//   one. Ones it doesn't have are added; ones only katasync has stay as they
//   are, with no stock until a stock pull (src/stock-push/pull.ts).
// - Recipes and aliases: set from the export.
//
// One transaction, holding the ledger, so a sale syncing in mid-refresh waits
// for it and then lands on top.

export type RefreshOptions = {
	// When the export was taken. Each store takes stock from here on.
	exportedAt: Date;
	// SKUs that sell without limit until counted (src/inventory/not-counted.ts).
	unlimited: string[];
	// SKUs to put on the count list.
	countFirst: string[];
};

export type RefreshResult = {
	updated: number;
	added: string[];
	// Products katasync has that the export doesn't.
	untouched: string[];
	openingStock: number;
	salesRetaken: number;
	problems: string[];
};

export async function refreshFromSumtracker(
	db: Db,
	plan: ImportPlan,
	options: RefreshOptions,
): Promise<RefreshResult> {
	if (options.exportedAt.getTime() > Date.now())
		throw new Error("The export time is in the future");
	return db.transaction(async (tx) => {
		await tx.execute(
			// orders too: an order syncing in waits here, then sees the new
			// stockFrom (ingestOrder reads it after saving the order).
			sql`lock table products, movements, orders, order_lines in access exclusive mode nowait`,
		);
		// A restock put units back through a movement this would wipe, and
		// nothing here takes it again.
		const [restocked] = await tx
			.select({ id: orderReturns.id })
			.from(orderReturns)
			.where(isNotNull(orderReturns.batchId))
			.limit(1);
		if (restocked)
			throw new Error(
				"A return was restocked; refreshing would lose it. Nothing changed.",
			);
		const location = await shippingLocation(tx);
		if (location === null)
			throw new Error("Stock needs exactly one location of our own");
		// Sumtracker only knows the warehouse, and starting over wipes every
		// shelf, so the store's stock and transfers would be lost.
		const [retail] = await tx
			.select({ name: locations.name })
			.from(locations)
			.where(eq(locations.kind, "retail"))
			.limit(1);
		if (retail)
			throw new Error(
				`Refreshing would wipe ${retail.name}'s stock, which Sumtracker doesn't have. Nothing changed.`,
			);

		await tx.execute(
			sql`truncate purchase_orders, damage_photo_uploads cascade`,
		);
		// The ledger refuses to be rewritten (movements_append_only); starting
		// stock over is the one deliberate exception, lifted only inside this
		// transaction, so a failure anywhere puts the guard back too.
		await tx.execute(
			sql`alter table movements disable trigger movements_append_only`,
		);
		await tx.execute(
			sql`truncate movements, stock_levels, stock_counts, count_log`,
		);
		await tx.execute(
			sql`alter table movements enable trigger movements_append_only`,
		);
		await tx.update(orderLines).set({ saleBatchId: null });

		const groupIds = new Map<string, number>();
		for (const g of plan.groups) {
			const [row] = await tx
				.insert(productGroups)
				.values(g)
				.onConflictDoUpdate({
					target: productGroups.name,
					set: { name: g.name },
				})
				.returning({ id: productGroups.id });
			groupIds.set(g.name, row.id);
		}

		const existing = await tx.select().from(products);
		const bySku = new Map(existing.map((p) => [p.sku, p]));
		const barcodeOwner = new Map(
			existing.flatMap((p) => (p.barcode ? [[p.barcode, p.sku]] : [])),
		);
		const problems: string[] = [];
		const added: string[] = [];
		let updated = 0;
		for (const { groupName, ...p } of plan.products) {
			const groupId = groupName === null ? null : groupIds.get(groupName);
			// A barcode another product already has stays where it is.
			const barcode =
				p.barcode && (barcodeOwner.get(p.barcode) ?? p.sku) === p.sku
					? p.barcode
					: null;
			if (p.barcode && !barcode)
				problems.push(
					`${p.sku}: barcode ${p.barcode} is already on ${barcodeOwner.get(p.barcode)}; left off`,
				);
			const was = bySku.get(p.sku);
			if (!was) {
				await tx
					.insert(products)
					.values({ ...p, barcode, groupId: groupId ?? null });
				if (barcode) barcodeOwner.set(barcode, p.sku);
				added.push(p.sku);
				continue;
			}
			if (was.kind !== p.kind)
				throw new Error(
					`${p.sku} is a ${was.kind} here but a ${p.kind} in the export. Nothing changed.`,
				);
			// Only what the export has; it never blanks a detail.
			const next = {
				name: p.name,
				variantName: p.variantName ?? was.variantName,
				groupId: groupId ?? was.groupId,
				imageUrl: p.imageUrl ?? was.imageUrl,
				category: p.category ?? was.category,
				barcode: barcode ?? was.barcode,
				unitCost: p.unitCost ?? was.unitCost,
			};
			// A variant needs a group, and a group alone needs no variant.
			if (next.variantName !== null && next.groupId === null)
				next.variantName = null;
			if (
				Object.entries(next).some(([k, v]) => was[k as keyof typeof was] !== v)
			) {
				await tx.update(products).set(next).where(eq(products.id, was.id));
				if (barcode) barcodeOwner.set(barcode, p.sku);
				updated++;
			}
		}

		const ids = new Map(
			(
				await tx.select({ id: products.id, sku: products.sku }).from(products)
			).map((p) => [p.sku, p.id]),
		);
		const idOf = (sku: string) => {
			const id = ids.get(sku);
			if (id === undefined) throw new Error(`No product ${sku}`);
			return id;
		};
		for (const [bundle, parts] of plan.recipes)
			await setRecipe(
				tx,
				idOf(bundle),
				parts.map((c) => ({ productId: idOf(c.sku), quantity: c.quantity })),
			);
		if (plan.aliases.length > 0)
			await tx
				.insert(productAliases)
				.values(
					plan.aliases.map((a) => ({ alias: a.alias, productId: idOf(a.sku) })),
				)
				.onConflictDoNothing();

		// Sumtracker is where close-at was set, so it's taken as the export has
		// it, cleared where the export has none.
		for (const s of plan.shelves) {
			const was = bySku.get(s.sku);
			if (!was || was.closeAt !== s.closeAt)
				await tx
					.update(products)
					.set({ closeAt: s.closeAt })
					.where(eq(products.sku, s.sku));
		}

		// What could be sold at the export: what's on the shelf less what's
		// booked, as Sumtracker set the channels. The booked orders were placed
		// before the export, so they take no stock here. Empty shelves too, so
		// they're on record as empty rather than unknown.
		const opening = plan.shelves.map((s) => ({
			sku: s.sku,
			quantity: s.inStock - s.booked,
		}));
		if (opening.length > 0)
			await postMovements(tx, {
				reference: "sumtracker-refresh",
				note: `Opening stock from the Sumtracker export of ${options.exportedAt.toISOString()}`,
				lines: opening.map((s) => ({
					productId: idOf(s.sku),
					locationId: location,
					delta: s.quantity,
					reason: "opening_balance" as const,
				})),
			});

		await tx.update(stores).set({ stockFrom: options.exportedAt });
		// The sales since the export, as ingestOrder takes them
		// (orderTakesStock).
		const since = await tx
			.select({
				id: orderLines.id,
				orderId: orderLines.orderId,
				productId: orderLines.productId,
				quantity: orderLines.quantity,
				orderName: orders.name,
				soldInStore: orders.soldInStore,
			})
			.from(orderLines)
			.innerJoin(orders, eq(orders.id, orderLines.orderId))
			.where(
				and(
					gte(orders.placedAt, options.exportedAt),
					eq(orders.fulfilledByChannel, false),
					sql`${orders.cancelledAt} is null`,
					isNotNull(orderLines.productId),
					sql`${orderLines.quantity} > 0`,
				),
			)
			.orderBy(orders.placedAt, orderLines.id);
		let salesRetaken = 0;
		for (const line of since) {
			const problem = await takeStock(
				tx,
				{ ...line, productId: line.productId as number },
				{ name: line.orderName, soldInStore: line.soldInStore },
				// No retail store, as checked above.
				{ shipping: location, store: null, pos: null, storeKeeps: 0 },
			);
			if (problem) problems.push(problem);
			else salesRetaken++;
		}

		const unknown = [...options.unlimited, ...options.countFirst].filter(
			(s) => !ids.has(s),
		);
		if (unknown.length > 0)
			throw new Error(
				`No product for: ${unknown.join(", ")}. Nothing changed.`,
			);
		const unlimited = options.unlimited.map((s) => idOf(s));
		await markNotCounted(tx, unlimited);
		const unlimitedSet = new Set(unlimited);
		const toCount = options.countFirst
			.map((s) => idOf(s))
			.filter((id) => !unlimitedSet.has(id));
		await requestCounts(tx, { productIds: toCount, locationId: location });

		const planned = new Set(plan.products.map((p) => p.sku));

		return {
			updated,
			added,
			untouched: existing.filter((p) => !planned.has(p.sku)).map((p) => p.sku),
			openingStock: plan.openingStock.length,
			salesRetaken,
			problems,
		};
	});
}
