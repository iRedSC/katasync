import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import {
	products,
	purchaseOrderLines,
	purchaseOrders,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { carried } from "#/products/archive";
import { cheapestOffers } from "#/purchasing/catalogs";
import {
	addDraftLine,
	addLine,
	openDraft,
	PurchaseOrderError,
	removeAddedLine,
} from "#/purchasing/orders";
import { setSuppliers } from "#/purchasing/suppliers";
import { listProducts } from "#/server/catalog/product-list";
import { onHandOf } from "./on-hand";

// Products to add to a PO, best match first: an exact SKU, barcode, or this
// supplier's SKU (a scan) leads, then products this PO's supplier sells.
// Each says if it's already on the PO, whether this supplier sells it, and
// who reorder buys it from (its cheapest), so the picker can warn before
// adding the wrong thing.
export const searchForPurchaseOrder = createServerFn({ method: "GET" })
	.validator(type({ purchaseOrderId: "number.integer > 0", query: "string" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const q = data.query.trim();
		if (q === "") return [];
		const [po] = await db
			.select({ supplierId: purchaseOrders.supplierId })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.id, data.purchaseOrderId));
		if (!po)
			throw new PurchaseOrderError(`PO ${data.purchaseOrderId} doesn't exist`);
		const cheapestOffer = cheapestOffers(db);
		const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		// Coalesced: descending order puts nulls first.
		const exact = sql<boolean>`coalesce(lower(${products.sku}) = lower(${q}) or ${products.barcode} = ${q} or lower(${supplierOffers.supplierSku}) = lower(${q}), false)`;
		const rows = await db
			.select({
				productId: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				kind: products.kind,
				supplierSku: supplierOffers.supplierSku,
				sold: sql<boolean>`${supplierOffers.productId} is not null`,
				cheapest: sql<boolean>`coalesce(${supplierOffers.cheapest}, false)`,
				supplierId: cheapestOffer.supplierId,
				supplierName: suppliers.name,
				unit: supplierOffers.unit,
				packSize: supplierOffers.packSize,
				supplierCount: supplierOffers.supplierCount,
				cost: supplierOffers.cost,
				lineId: purchaseOrderLines.id,
			})
			.from(products)
			.leftJoin(
				supplierOffers,
				and(
					eq(supplierOffers.productId, products.id),
					eq(supplierOffers.supplierId, po.supplierId),
				),
			)
			.leftJoin(cheapestOffer, eq(cheapestOffer.productId, products.id))
			.leftJoin(suppliers, eq(suppliers.id, cheapestOffer.supplierId))
			.leftJoin(
				purchaseOrderLines,
				and(
					eq(purchaseOrderLines.purchaseOrderId, data.purchaseOrderId),
					eq(purchaseOrderLines.productId, products.id),
				),
			)
			.where(
				and(
					carried,
					or(
						sql`${products.sku} ilike ${like}`,
						sql`${products.name} ilike ${like}`,
						sql`${products.variantName} ilike ${like}`,
						sql`${products.barcode} ilike ${like}`,
						sql`${supplierOffers.supplierSku} ilike ${like}`,
					),
				),
			)
			.orderBy(
				desc(exact),
				desc(sql`${supplierOffers.productId} is not null`),
				products.name,
				products.variantName,
			)
			.limit(12);
		const onHand = await onHandOf(
			db,
			rows.map((r) => r.productId),
		);
		return rows.map(({ sold, ...r }) => ({
			...r,
			onHand: onHand.get(r.productId) ?? 0,
			fromThisSupplier: sold,
		}));
	});

export type PurchaseOrderMatch = Awaited<
	ReturnType<typeof searchForPurchaseOrder>
>[number];

// Everything this PO's supplier sells, read as the product list reads it,
// with what the supplier charges and how they sell it, and tool sets ordered
// from it. Browse filters and
// sorts these in the page, so it takes the whole list at once.
export const browseForPurchaseOrder = createServerFn({ method: "GET" })
	.validator(type({ purchaseOrderId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [po] = await db
			.select({ supplierId: purchaseOrders.supplierId })
			.from(purchaseOrders)
			.where(eq(purchaseOrders.id, data.purchaseOrderId));
		if (!po)
			throw new PurchaseOrderError(`PO ${data.purchaseOrderId} doesn't exist`);
		const [{ products: all }, terms] = await Promise.all([
			listProducts(),
			db
				.select({
					productId: supplierOffers.productId,
					supplierSku: supplierOffers.supplierSku,
					unit: supplierOffers.unit,
					packSize: supplierOffers.packSize,
					supplierCount: supplierOffers.supplierCount,
					cost: supplierOffers.cost,
					minimumQuantity: supplierOffers.minimumQuantity,
				})
				.from(supplierOffers)
				.where(eq(supplierOffers.supplierId, po.supplierId)),
		]);
		const termsOf = new Map(terms.map(({ productId, ...t }) => [productId, t]));
		// A tool set's supplier is the one most of its parts come from, and it
		// has no terms of its own.
		return all
			.filter(
				(p) =>
					termsOf.has(p.id) ||
					(p.kind === "bundle" && p.supplier?.id === po.supplierId),
			)
			.map((p) => ({ ...p, terms: termsOf.get(p.id) ?? null }));
	});

export type BrowseRow = Awaited<
	ReturnType<typeof browseForPurchaseOrder>
>[number];

// Adds a product to a PO at the fewest its supplier sells. A product already
// on it is left alone and comes back with added false, so the page can point
// at its line instead. On a sent PO the supplier isn't told.
export const addProductToPurchaseOrder = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			// Putting back a line that was taken off: when it was first added.
			"addedAt?": "Date",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [link] = await db
			.select({ minimum: supplierOffers.minimumQuantity })
			.from(purchaseOrders)
			.innerJoin(
				supplierOffers,
				eq(supplierOffers.supplierId, purchaseOrders.supplierId),
			)
			.where(
				and(
					eq(purchaseOrders.id, data.purchaseOrderId),
					eq(supplierOffers.productId, data.productId),
				),
			);
		const { added, line } = await addLine(db, {
			...data,
			quantity: link?.minimum ?? 1,
		});
		return { added, lineId: line.id };
	});

// Puts a product on its cheapest supplier's draft, starting one if needed. Without a
// quantity it's the fewest the supplier sells. A product already on the draft
// is left as it is and comes back with added false. Says where it went, and
// the line as added, which is what undo needs.
export const addToPurchaseOrder = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			"quantity?": "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [link] = await db
			.select({
				supplierId: supplierOffers.supplierId,
				supplierName: suppliers.name,
				minimum: supplierOffers.minimumQuantity,
			})
			.from(supplierOffers)
			.innerJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
			.where(
				and(
					eq(supplierOffers.productId, data.productId),
					eq(supplierOffers.cheapest, true),
				),
			);
		// A tool set goes to the supplier of most of its parts, one at a time.
		const order =
			link ??
			(await setSuppliers(db, [data.productId]).then((m) => {
				const s = m.get(data.productId);
				return s && { supplierId: s.id, supplierName: s.name, minimum: 1 };
			}));
		if (!order)
			throw new PurchaseOrderError(
				"No supplier sells it: put it in a catalog a supplier carries (for a tool set, its parts)",
			);
		const purchaseOrderId = await openDraft(db, order.supplierId);
		const { added, line } = await addDraftLine(db, {
			purchaseOrderId,
			productId: data.productId,
			quantity: data.quantity ?? order.minimum,
		});
		return { added, purchaseOrderId, supplierName: order.supplierName, line };
	});

// Undoes addToPurchaseOrder. Returns false, changing nothing, when the line
// has been changed or removed since.
export const undoAddToPurchaseOrder = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			line: {
				id: "number.integer > 0",
				unit: "string",
				packSize: "number.integer > 0",
				supplierCount: "number.integer > 0",
				minimumQuantity: "number.integer > 0",
				quantity: "number.integer > 0",
				unitCost: "number | null",
			},
		}),
	)
	.handler(async ({ data }) => removeAddedLine(getDb(), data));
