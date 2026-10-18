import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import {
	locations,
	productSuppliers,
	products,
	purchaseOrderAmendments,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
	suppliers,
} from "#/db/schema";
import { stockRanges } from "#/inventory/stock-range";
import {
	type DamageReportItem,
	damagesOf,
	recordDamage,
	removeDamage,
	removeDamagePhoto,
	sendDamageReport,
} from "#/purchasing/damage";
import { emailConfigured, sendEmail } from "#/purchasing/email";
import { type LeadTime, leadTimes } from "#/purchasing/forecast";
import { invoicesOf } from "#/purchasing/invoices";
import {
	documentFor,
	loadOrder,
	receivedByLine,
	supplierRows,
} from "#/purchasing/load";
import {
	addDraftLine,
	addLine,
	addSetToOtherDrafts,
	amendLine,
	cancelOrder,
	closeOrder,
	deleteDraft,
	draftChanges,
	draftFromSuggestions,
	lockDraftLine,
	markSent,
	openDraft,
	openSuggested,
	orderAgain,
	PurchaseOrderError,
	partsOfSets,
	receive,
	receiveExtra,
	refreshSuggested,
	removeAddedLine,
	restoreDraft,
	restoreOrder,
	setDraftLine,
	setPartsOf,
	setReceivingNote,
	skipSetPart,
	undoReceipt,
	updateDraft,
	updateFromSuggestions,
} from "#/purchasing/orders";
import {
	readyToOrder,
	recommendedAdditions,
	reorderBreakdown,
	suggestPurchases,
} from "#/purchasing/reorder";
import {
	setProductSupplier as setProductSupplierLink,
	setSuppliers,
	updateSupplier as updateSupplierDetails,
} from "#/purchasing/suppliers";
import {
	addUnit,
	deleteUnit,
	listUnits,
	renameUnit,
	setLineTerms,
	setPurchaseUnit,
} from "#/purchasing/units";
import { listProducts } from "#/server/catalog";

const id = type({ id: "number.integer > 0" });

// Suggestions ready to order, and every PO still open plus the latest finished ones.
export const listPurchasing = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const received = receivedByLine(db);
		const [suggestions, orders, supplierNames] = await Promise.all([
			suggestPurchases(db),
			db
				.select({
					id: purchaseOrders.id,
					status: purchaseOrders.status,
					supplierId: suppliers.id,
					supplierName: suppliers.name,
					supplierEmail: suppliers.email,
					sentAt: purchaseOrders.sentAt,
					expectedAt: purchaseOrders.expectedAt,
					closedAt: purchaseOrders.closedAt,
					createdAt: purchaseOrders.createdAt,
					lines: sql<number>`count(${purchaseOrderLines.id})::int`,
					// Counted in the product itself, so cases and eaches add up.
					ordered: sql<number>`coalesce(sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize}), 0)::int`,
					received: sql<number>`coalesce(sum(least(coalesce(${received.units}, 0), ${purchaseOrderLines.quantity}) * ${purchaseOrderLines.packSize}), 0)::int`,
					total: sql<number>`coalesce(sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.unitCost}), 0)::float`,
				})
				.from(purchaseOrders)
				.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
				.leftJoin(
					purchaseOrderLines,
					eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id),
				)
				.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
				// Suggested POs show as their suggestion, under Ready to order.
				.where(ne(purchaseOrders.status, "suggested"))
				.groupBy(purchaseOrders.id, suppliers.id)
				.orderBy(desc(purchaseOrders.id))
				.limit(200),
			db
				.select({ id: suppliers.id, name: suppliers.name })
				.from(suppliers)
				.orderBy(suppliers.name),
		]);
		// Open: drafts still being put together. Incoming: sent, waiting on
		// deliveries.
		const open = orders.filter((o) => o.status === "draft");
		const incoming = orders.filter((o) => o.status === "sent");
		const done = orders
			.filter((o) => o.status === "closed" || o.status === "cancelled")
			.slice(0, 30);
		return {
			ready: readyToOrder(suggestions),
			open,
			incoming,
			done,
			suppliers: supplierNames,
		};
	},
);

export type PurchasingList = Awaited<ReturnType<typeof listPurchasing>>;

// "POs ready" on Home: the same list as "Ready to order".
export const countPosReady = createServerFn({ method: "GET" }).handler(
	async () => readyToOrder(await suggestPurchases(getDb())).length,
);

// Owned stock for each product, so a draft shows what's already on the shelf.
async function onHandOf(db: Db, productIds: number[]) {
	if (productIds.length === 0) return new Map<number, number>();
	const rows = await db
		.select({
			productId: stockLevels.productId,
			onHand: sql<number>`sum(${stockLevels.onHand})::int`,
		})
		.from(stockLevels)
		.innerJoin(locations, eq(locations.id, stockLevels.locationId))
		.where(
			and(
				eq(locations.kind, "owned"),
				inArray(stockLevels.productId, productIds),
			),
		)
		.groupBy(stockLevels.productId);
	return new Map(rows.map((r) => [r.productId, r.onHand]));
}

export const getPurchaseOrder = createServerFn({ method: "GET" })
	.validator(id)
	.handler(async ({ data }) => {
		const db = getDb();
		// A suggested PO shows today's suggestion, not the one it was opened with.
		await refreshSuggested(db, data.id);
		const po = await loadOrder(db, data.id);
		const unsent =
			po.order.status === "draft" || po.order.status === "suggested";
		const setParts = unsent ? await setPartsOf(db, data.id) : [];
		// A set's parts show their stock too.
		const productIds = [
			...new Set([
				...po.lines.map((l) => l.productId),
				...setParts.map((p) => p.productId),
			]),
		];
		const [
			onHand,
			ranges,
			receipts,
			ownedLocations,
			changes,
			units,
			lead,
			amendments,
			recommended,
			whys,
			invoices,
			damages,
		] = await Promise.all([
			onHandOf(db, productIds),
			stockRanges(db, productIds),
			// The latest receipts that can still be undone.
			db
				.select({
					id: purchaseOrderReceipts.id,
					lineId: purchaseOrderReceipts.lineId,
					quantity: purchaseOrderReceipts.quantity,
					// Set when the receipt changed what the line expects.
					quantityBefore: purchaseOrderReceipts.quantityBefore,
					quantityAfter: purchaseOrderReceipts.quantityAfter,
					createdAt: purchaseOrderReceipts.createdAt,
				})
				.from(purchaseOrderReceipts)
				.innerJoin(
					purchaseOrderLines,
					eq(purchaseOrderLines.id, purchaseOrderReceipts.lineId),
				)
				.where(
					and(
						eq(purchaseOrderLines.purchaseOrderId, data.id),
						isNull(purchaseOrderReceipts.undoesId),
						sql`not exists (select 1 from ${purchaseOrderReceipts} u where u.undoes_id = ${purchaseOrderReceipts.id})`,
					),
				)
				.orderBy(desc(purchaseOrderReceipts.id))
				.limit(50),
			db
				.select({ id: locations.id, name: locations.name })
				.from(locations)
				.where(eq(locations.kind, "owned"))
				.orderBy(locations.name),
			// On a draft: how today's suggestions differ from it (see draftChanges).
			// The page works out raised and skipped from each line's wants, so
			// they follow quantities and locks as they change. A suggested PO is
			// the suggestion.
			po.order.status === "draft"
				? Promise.all([suggestPurchases(db), partsOfSets(db, data.id)]).then(
						([all, fromSets]) => {
							const c = draftChanges(
								po.lines,
								all.find((s) => s.supplierId === po.supplier.id)?.lines ?? [],
								fromSets,
							);
							return { added: c.added.length, wants: c.wants };
						},
					)
				: { added: 0, wants: new Map<number, number>() },
			listUnits(db).then((all) => all.map((u) => u.name)),
			leadTimes(db, [po.supplier.id]),
			// Changes made after sending, for the timeline.
			db
				.select({
					id: purchaseOrderAmendments.id,
					kind: purchaseOrderAmendments.kind,
					quantityBefore: purchaseOrderAmendments.quantityBefore,
					quantityAfter: purchaseOrderAmendments.quantityAfter,
					unitCostBefore: purchaseOrderAmendments.unitCostBefore,
					unitCostAfter: purchaseOrderAmendments.unitCostAfter,
					createdAt: purchaseOrderAmendments.createdAt,
					name: products.name,
					variantName: products.variantName,
				})
				.from(purchaseOrderAmendments)
				.innerJoin(products, eq(products.id, purchaseOrderAmendments.productId))
				.where(eq(purchaseOrderAmendments.purchaseOrderId, data.id))
				.orderBy(desc(purchaseOrderAmendments.id))
				.limit(200),
			// On a draft: what else from this supplier is worth adding (see
			// recommendedAdditions), leaving out what's on it already, sets'
			// parts too.
			unsent
				? partsOfSets(db, data.id).then((fromSets) =>
						recommendedAdditions(
							db,
							po.supplier.id,
							new Set([...productIds, ...fromSets.keys()]),
						),
					)
				: [],
			// Why reorder wants what it does of each, for the velocity gauge.
			reorderBreakdown(db, { productIds }).then(
				(all) => new Map(all.map((b) => [b.line.productId, b.why])),
			),
			invoicesOf(db, data.id),
			damagesOf(db, data.id),
		]);
		return {
			leadTime: leadTimeOf(lead, po.supplier.id),
			changes: { added: changes.added },
			...po,
			lines: po.lines.map((l) => ({
				...l,
				// Single items today's suggestion wants; null when it doesn't
				// have the product, or on anything but a draft.
				wants: changes.wants.get(l.productId) ?? null,
				onHand: onHand.get(l.productId) ?? 0,
				// Every line's product has one; ?? only satisfies the Map type.
				stockRange: ranges.get(l.productId) ?? null,
				// Null for tool sets: they're ordered as their parts.
				why: whys.get(l.productId) ?? null,
			})),
			setParts: setParts.map((p) => ({
				...p,
				onHand: onHand.get(p.productId) ?? 0,
				stockRange: ranges.get(p.productId) ?? null,
				why: whys.get(p.productId) ?? null,
			})),
			recommended,
			receipts,
			amendments,
			invoices,
			damages,
			locations: ownedLocations,
			units,
			emailConfigured: emailConfigured(),
		};
	});

export type PurchaseOrderDetail = Awaited<ReturnType<typeof getPurchaseOrder>>;

// Starts a blank draft for a supplier, or opens the one they have.
export const createDraft = createServerFn({ method: "POST" })
	.validator(type({ supplierId: "number.integer > 0" }))
	.handler(async ({ data }) => openDraft(getDb(), data.supplierId));

// Makes the supplier's draft from today's suggestion.
export const createDraftFromSuggestions = createServerFn({ method: "POST" })
	.validator(type({ supplierId: "number.integer > 0" }))
	.handler(async ({ data }) => draftFromSuggestions(getDb(), data.supplierId));

// Opens a supplier's suggestion as a PO without making it a draft yet.
export const openSuggestedPurchaseOrder = createServerFn({ method: "POST" })
	.validator(type({ supplierId: "number.integer > 0" }))
	.handler(async ({ data }) => openSuggested(getDb(), data.supplierId));

// Brings a frozen draft up to date with what needs reordering today.
export const updateDraftFromSuggestions = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => updateFromSuggestions(getDb(), data.id));

// Puts a recommended addition on the draft at the quantity recommended. A
// product that got onto the draft meanwhile is left as it is.
export const addRecommended = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			quantity: "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => addDraftLine(getDb(), data));

export const setLine = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			quantity: "number.integer >= 0",
			"unitCost?": "number >= 0 | null",
		}),
	)
	.handler(async ({ data }) => setDraftLine(getDb(), data));

// Locks a draft line's quantity so Update leaves it alone, or unlocks it.
export const lockLine = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			locked: "boolean",
		}),
	)
	.handler(async ({ data }) => lockDraftLine(getDb(), data));

// Skips one part of a set on a draft, or orders it again.
export const skipPartOfSet = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			productId: "number.integer > 0",
			skipped: "boolean",
		}),
	)
	.handler(async ({ data }) => skipSetPart(getDb(), data));

// Puts a set on the drafts of the other suppliers its parts are bought from.
export const addSetToOtherPos = createServerFn({ method: "POST" })
	.validator(type({ lineId: "number.integer > 0" }))
	.handler(async ({ data }) => addSetToOtherDrafts(getDb(), data));

export const editDraft = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			"notes?": "string | null",
			"locationId?": "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => updateDraft(getDb(), data));

// Products to add to a PO, best match first: an exact SKU, barcode, or
// supplier SKU (a scan) leads, then products bought from this PO's supplier.
// Each says if it's already on the PO and who it's bought from, so the picker
// can warn before adding the wrong thing.
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
		const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		// Coalesced: descending order puts nulls first.
		const exact = sql<boolean>`coalesce(lower(${products.sku}) = lower(${q}) or ${products.barcode} = ${q} or lower(${productSuppliers.supplierSku}) = lower(${q}), false)`;
		const rows = await db
			.select({
				productId: products.id,
				sku: products.sku,
				name: products.name,
				variantName: products.variantName,
				imageUrl: products.imageUrl,
				kind: products.kind,
				supplierSku: productSuppliers.supplierSku,
				supplierId: productSuppliers.supplierId,
				supplierName: suppliers.name,
				unit: productSuppliers.unit,
				packSize: productSuppliers.packSize,
				supplierCount: productSuppliers.supplierCount,
				cost: productSuppliers.cost,
				lineId: purchaseOrderLines.id,
			})
			.from(products)
			.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
			.leftJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.leftJoin(
				purchaseOrderLines,
				and(
					eq(purchaseOrderLines.purchaseOrderId, data.purchaseOrderId),
					eq(purchaseOrderLines.productId, products.id),
				),
			)
			.where(
				or(
					sql`${products.sku} ilike ${like}`,
					sql`${products.name} ilike ${like}`,
					sql`${products.variantName} ilike ${like}`,
					sql`${products.barcode} ilike ${like}`,
					sql`${productSuppliers.supplierSku} ilike ${like}`,
				),
			)
			.orderBy(
				desc(exact),
				desc(
					sql`coalesce(${productSuppliers.supplierId} = ${po.supplierId}, false)`,
				),
				products.name,
				products.variantName,
			)
			.limit(12);
		const onHand = await onHandOf(
			db,
			rows.map((r) => r.productId),
		);
		return rows.map((r) => ({
			...r,
			onHand: onHand.get(r.productId) ?? 0,
			fromThisSupplier: r.supplierId === po.supplierId,
		}));
	});

export type PurchaseOrderMatch = Awaited<
	ReturnType<typeof searchForPurchaseOrder>
>[number];

// Everything bought from this PO's supplier, read as the product list reads
// it, with what the supplier charges and how they sell it. Browse filters and
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
					productId: productSuppliers.productId,
					supplierSku: productSuppliers.supplierSku,
					unit: productSuppliers.unit,
					packSize: productSuppliers.packSize,
					supplierCount: productSuppliers.supplierCount,
					cost: productSuppliers.cost,
					minimumQuantity: productSuppliers.minimumQuantity,
				})
				.from(productSuppliers)
				.where(eq(productSuppliers.supplierId, po.supplierId)),
		]);
		const termsOf = new Map(terms.map(({ productId, ...t }) => [productId, t]));
		// A tool set's supplier is the one most of its parts come from, and it
		// has no terms of its own.
		return all
			.filter((p) => p.supplier?.id === po.supplierId)
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
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const [link] = await db
			.select({ minimum: productSuppliers.minimumQuantity })
			.from(productSuppliers)
			.where(eq(productSuppliers.productId, data.productId));
		const { added, line } = await addLine(db, {
			...data,
			quantity: link?.minimum ?? 1,
		});
		return { added, lineId: line.id };
	});

// Changes a sent PO's line without telling the supplier.
export const amendPurchaseLine = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			"quantity?": "number.integer >= 0",
			"unitCost?": "number >= 0 | null",
		}),
	)
	.handler(async ({ data }) => amendLine(getDb(), data));

// Notes a line for receiving; null takes the note off.
export const setLineReceivingNote = createServerFn({ method: "POST" })
	.validator(type({ lineId: "number.integer > 0", note: "string | null" }))
	.handler(async ({ data }) => setReceivingNote(getDb(), data));

// Puts a product on its supplier's draft, starting one if needed. Without a
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
				supplierId: productSuppliers.supplierId,
				supplierName: suppliers.name,
				minimum: productSuppliers.minimumQuantity,
			})
			.from(productSuppliers)
			.innerJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.where(eq(productSuppliers.productId, data.productId));
		// A tool set goes to the supplier of most of its parts, one at a time.
		const order =
			link ??
			(await setSuppliers(db, [data.productId]).then((m) => {
				const s = m.get(data.productId);
				return s && { supplierId: s.id, supplierName: s.name, minimum: 1 };
			}));
		if (!order)
			throw new PurchaseOrderError(
				"Set this product's supplier first (for a tool set, its parts')",
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

// Emails the PO to the supplier and puts it on order. With `email: false` it's
// only marked sent, for orders placed by phone or on the supplier's website.
export const sendPurchaseOrder = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", email: "boolean" }))
	.handler(async ({ data }) => {
		const db = getDb();
		if (!data.email) {
			await markSent(db, { purchaseOrderId: data.id, sentTo: null });
			return { sentTo: null };
		}
		const sentTo = await markSent(db, {
			purchaseOrderId: data.id,
			// Built inside the send, with the PO locked, so the email matches
			// exactly what's saved as sent.
			deliver: async (tx) => {
				const { po, pdf, filename } = await documentFor(tx, data.id);
				const to = po.supplier.email;
				if (!to)
					throw new PurchaseOrderError(
						`${po.supplier.name} has no email. Add one in Suppliers, or mark it sent.`,
					);
				const from = po.location.shipFromName ?? po.location.name;
				await sendEmail({
					to,
					subject: `Purchase order ${data.id} from ${from}`,
					text: [
						po.supplier.contactName
							? `Hi ${po.supplier.contactName},`
							: "Hello,",
						"",
						`Please find purchase order ${data.id} attached (${po.lines.length} ${po.lines.length === 1 ? "item" : "items"}). Reply to this email to confirm, or with any changes or backorders.`,
						"",
						"Thank you,",
						from,
					].join("\n"),
					attachments: [{ filename, content: pdf }],
				});
				return to;
			},
		});
		return { sentTo };
	});

// `last`: nothing more of it is coming, so the line expects only what came.
export const receiveLine = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			"last?": "boolean",
		}),
	)
	.handler(async ({ data }) => receive(getDb(), data));

// Something in the box that isn't on the PO: added and received at once.
export const receiveExtraLine = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			quantity: "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => receiveExtra(getDb(), data));

export const undoPurchaseReceipt = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => undoReceipt(getDb(), data.id));

export const closePurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => closeOrder(getDb(), data.id));

export const cancelPurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => cancelOrder(getDb(), data.id));

// Undoes cancelPurchaseOrder: back on order.
export const restorePurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => restoreOrder(getDb(), data.id));

// Returns what was deleted, for restoreDraftPurchaseOrder.
export const deleteDraftPurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => deleteDraft(getDb(), data.id));

const positive = "number.integer > 0";

// Undoes deleteDraftPurchaseOrder with what it returned.
export const restoreDraftPurchaseOrder = createServerFn({ method: "POST" })
	.validator(
		type({
			id: positive,
			supplierId: positive,
			locationId: positive,
			notes: "string | null",
			createdAt: "Date",
			lines: type({
				productId: positive,
				unit: "string",
				packSize: positive,
				supplierCount: positive,
				minimumQuantity: positive,
				quantity: "number.integer >= 0",
				unitCost: "number | null",
			}).array(),
			skippedParts: type({
				setProductId: positive,
				partProductId: positive,
			}).array(),
		}),
	)
	.handler(async ({ data }) => restoreDraft(getDb(), data));

// A finished PO's products onto its supplier's draft again.
export const orderPurchaseOrderAgain = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => orderAgain(getDb(), data.id));

// POs waiting on deliveries, for the receiving app.
export const listReceivable = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const received = receivedByLine(db);
		return db
			.select({
				id: purchaseOrders.id,
				supplierName: suppliers.name,
				expectedAt: purchaseOrders.expectedAt,
				lines: sql<number>`count(*)::int`,
				ordered: sql<number>`sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize})::int`,
				received: sql<number>`coalesce(sum(least(coalesce(${received.units}, 0), ${purchaseOrderLines.quantity}) * ${purchaseOrderLines.packSize}), 0)::int`,
			})
			.from(purchaseOrders)
			.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id),
			)
			.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
			.where(eq(purchaseOrders.status, "sent"))
			.groupBy(purchaseOrders.id, suppliers.id)
			.orderBy(purchaseOrders.expectedAt);
	},
);

// Each supplier with the lead time reorder plans on.
export const listSuppliers = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [rows, lead] = await Promise.all([supplierRows(db), leadTimes(db)]);
		return rows.map((r) => ({
			...r,
			leadTime: leadTimeOf(lead, r.supplier.id),
		}));
	},
);

// leadTimes answers for every supplier it's asked about.
function leadTimeOf(lead: Map<number, LeadTime>, supplierId: number) {
	const l = lead.get(supplierId);
	if (!l) throw new Error(`No lead time for supplier ${supplierId}`);
	return l;
}

export type SupplierRow = Awaited<ReturnType<typeof listSuppliers>>[number];

const text = "string | null";
export const updateSupplier = createServerFn({ method: "POST" })
	.validator(
		type({
			id: "number.integer > 0",
			name: "string > 0",
			contactName: text,
			email: type("string.email | null").or("''"),
			phone: text,
			address1: text,
			address2: text,
			city: text,
			region: text,
			postalCode: text,
			country: text,
			paymentTerms: text,
			notes: text,
			poNotes: text,
			leadTimeDays: "1 <= number.integer <= 365",
			coverDays: "1 <= number.integer <= 365",
			minimumOrder: "number >= 0",
			criticalThreshold: "number.integer >= 1",
		}),
	)
	.handler(async ({ data: { id: supplierId, ...values } }) =>
		updateSupplierDetails(getDb(), supplierId, values),
	);

// Just the email, so a PO can be sent from its own page without opening the
// whole supplier form.
export const setSupplierEmail = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", email: "string.email" }))
	.handler(async ({ data }) =>
		updateSupplierDetails(getDb(), data.id, { email: data.email }),
	);

// Who a product comes from, for its product page. Null when no supplier.
export const getProductSupplier = createServerFn({ method: "GET" })
	.validator(type({ productId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const links = await db
			.select({
				supplierId: suppliers.id,
				supplierName: suppliers.name,
				supplierSku: productSuppliers.supplierSku,
				cost: productSuppliers.cost,
				unit: productSuppliers.unit,
				packSize: productSuppliers.packSize,
				supplierCount: productSuppliers.supplierCount,
				minimumQuantity: productSuppliers.minimumQuantity,
			})
			.from(productSuppliers)
			.innerJoin(suppliers, eq(suppliers.id, productSuppliers.supplierId))
			.where(eq(productSuppliers.productId, data.productId));
		const open = await db
			.select({
				id: purchaseOrders.id,
				status: purchaseOrders.status,
				quantity: purchaseOrderLines.quantity,
				unit: purchaseOrderLines.unit,
				packSize: purchaseOrderLines.packSize,
				supplierCount: purchaseOrderLines.supplierCount,
				expectedAt: purchaseOrders.expectedAt,
			})
			.from(purchaseOrderLines)
			.innerJoin(
				purchaseOrders,
				eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
			)
			.where(
				and(
					eq(purchaseOrderLines.productId, data.productId),
					or(
						eq(purchaseOrders.status, "draft"),
						eq(purchaseOrders.status, "sent"),
					),
				),
			)
			.orderBy(purchaseOrders.id);
		// A product may have no supplier yet.
		const link = links.at(0) ?? null;
		return { link, open, units: await listUnits(db) };
	});

// Sets or changes who a product comes from. supplierId null removes it.
export const setProductSupplier = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			supplierId: "number.integer > 0 | null",
			"supplierSku?": "string | null",
			"cost?": "number >= 0 | null",
		}),
	)
	.handler(async ({ data }) => setProductSupplierLink(getDb(), data));

// What a product is bought in (CASE of 30) and the fewest the supplier sells.
export const setProductPurchaseUnit = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			unit: "string > 0",
			packSize: "number.integer > 0",
			supplierCount: "number.integer > 0",
			minimumQuantity: "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => setPurchaseUnit(getDb(), data));

// What one draft PO orders a product in, and its minimum. makeDefault also
// makes them the product's supplier default.
export const setPurchaseLineTerms = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			unit: "string > 0",
			packSize: "number.integer > 0",
			supplierCount: "number.integer > 0",
			minimumQuantity: "number.integer > 0",
			makeDefault: "boolean",
		}),
	)
	.handler(async ({ data }) => setLineTerms(getDb(), data));

export const listPurchaseUnits = createServerFn({ method: "GET" }).handler(
	async () => listUnits(getDb()),
);

export const addPurchaseUnit = createServerFn({ method: "POST" })
	.validator(type({ name: "string" }))
	.handler(async ({ data }) => addUnit(getDb(), data.name));

export const renamePurchaseUnit = createServerFn({ method: "POST" })
	.validator(type({ from: "string > 0", to: "string" }))
	.handler(async ({ data }) => renameUnit(getDb(), data.from, data.to));

export const deletePurchaseUnit = createServerFn({ method: "POST" })
	.validator(type({ name: "string > 0" }))
	.handler(async ({ data }) => deleteUnit(getDb(), data.name));

// Records items of a line that arrived damaged, in single items, and takes
// them off the shelf. Photos go to /api/damage-photos/$id after.
export const recordPurchaseDamage = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			description: "string",
		}),
	)
	.handler(async ({ data }) => recordDamage(getDb(), data));

// Takes back damage not yet reported: the items go back on the shelf.
export const removePurchaseDamage = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeDamage(getDb(), data.id));

export const removePurchaseDamagePhoto = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeDamagePhoto(getDb(), data.id));

const REMEDY_WORDS = {
	credit: "please credit us",
	replacement: "please send replacements",
} as const;

// The report as the supplier reads it: each item, what's wrong, and what we
// ask for, with every photo attached and named for its item.
export function damageEmail(
	input: {
		purchaseOrderId: number;
		contactName: string | null;
		from: string;
	},
	items: DamageReportItem[],
) {
	const photoCount = items.reduce((n, i) => n + i.photos.length, 0);
	const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
	return {
		subject: `Damage on purchase order ${input.purchaseOrderId} from ${input.from}`,
		text: [
			input.contactName ? `Hi ${input.contactName},` : "Hello,",
			"",
			`Some of what arrived on purchase order ${input.purchaseOrderId} was damaged:`,
			"",
			...items.map(
				(i) =>
					`- ${i.quantity} × ${i.name} (${i.sku}): ${i.description}. ${REMEDY_WORDS[i.remedy][0].toUpperCase()}${REMEDY_WORDS[i.remedy].slice(1)}.`,
			),
			"",
			...(photoCount > 0
				? [
						`${photoCount === 1 ? "A photo is" : `${photoCount} photos are`} attached.`,
						"",
					]
				: []),
			"Thank you,",
			input.from,
		].join("\n"),
		attachments: items.flatMap((i) =>
			i.photos.map((p, n) => ({
				filename: `${i.sku}-${n + 1}.${ext[p.contentType as keyof typeof ext] ?? "jpg"}`,
				content: p.data,
			})),
		),
	};
}

// Emails the supplier every damage on the PO not yet reported, each with
// credit or replacement, and records it as sent. Nothing is recorded if the
// email fails.
export const sendPurchaseDamageReport = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			remedies: type({
				damageId: "number.integer > 0",
				remedy: "'credit' | 'replacement'",
			}).array(),
		}),
	)
	.handler(async ({ data }) =>
		sendDamageReport(getDb(), {
			...data,
			deliver: async (tx, items) => {
				const po = await loadOrder(tx, data.purchaseOrderId);
				const to = po.supplier.email;
				if (!to)
					throw new PurchaseOrderError(
						`${po.supplier.name} has no email. Add one in Suppliers.`,
					);
				await sendEmail({
					to,
					...damageEmail(
						{
							purchaseOrderId: data.purchaseOrderId,
							contactName: po.supplier.contactName,
							from: po.location.shipFromName ?? po.location.name,
						},
						items,
					),
				});
				return to;
			},
		}),
	);
