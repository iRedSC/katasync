import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type Db, getDb } from "#/db/client";
import {
	locations,
	productSuppliers,
	products,
	purchaseOrderLines,
	purchaseOrderReceipts,
	purchaseOrders,
	stockLevels,
	suppliers,
} from "#/db/schema";
import { stockRanges } from "#/inventory/stock-range";
import { emailConfigured, sendEmail } from "#/purchasing/email";
import {
	documentFor,
	loadOrder,
	receivedByLine,
	setPartsOf,
	supplierRows,
} from "#/purchasing/load";
import {
	addDraftLine,
	cancelOrder,
	closeOrder,
	draftChanges,
	draftFromSuggestions,
	markSent,
	movePartToSupplier,
	openDraft,
	PurchaseOrderError,
	partsOfSets,
	receive,
	removeAddedLine,
	setDraftLine,
	undoReceipt,
	updateDraft,
	updateFromSuggestions,
} from "#/purchasing/orders";
import { suggestPurchases } from "#/purchasing/reorder";
import {
	setProductSupplier as setProductSupplierLink,
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

const id = type({ id: "number.integer > 0" });

// Today's suggestions, and every PO still open plus the latest finished ones.
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
					supplierName: suppliers.name,
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
				.groupBy(purchaseOrders.id, suppliers.name)
				.orderBy(desc(purchaseOrders.id))
				.limit(200),
			db
				.select({ id: suppliers.id, name: suppliers.name })
				.from(suppliers)
				.orderBy(suppliers.name),
		]);
		const open = orders.filter(
			(o) => o.status === "draft" || o.status === "sent",
		);
		const done = orders
			.filter((o) => o.status === "closed" || o.status === "cancelled")
			.slice(0, 30);
		return { suggestions, open, done, suppliers: supplierNames };
	},
);

export type PurchasingList = Awaited<ReturnType<typeof listPurchasing>>;

// "POs ready" on Home: suppliers whose suggested order reached their minimum.
export const countPosReady = createServerFn({ method: "GET" }).handler(
	async () => (await suggestPurchases(getDb())).filter((s) => s.ready).length,
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
		const po = await loadOrder(db, data.id);
		const productIds = po.lines.map((l) => l.productId);
		const [onHand, ranges, receipts, ownedLocations, changes, units, setParts] =
			await Promise.all([
				onHandOf(db, productIds),
				stockRanges(db, productIds),
				// The latest receipts that can still be undone.
				db
					.select({
						id: purchaseOrderReceipts.id,
						lineId: purchaseOrderReceipts.lineId,
						quantity: purchaseOrderReceipts.quantity,
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
				po.order.status === "draft"
					? Promise.all([suggestPurchases(db), partsOfSets(db, data.id)]).then(
							([all, fromSets]) => {
								const c = draftChanges(
									po.lines,
									all.find((s) => s.supplierId === po.supplier.id)?.lines ?? [],
									fromSets,
								);
								return { added: c.added.length, raised: c.raised.length };
							},
						)
					: { added: 0, raised: 0 },
				listUnits(db).then((all) => all.map((u) => u.name)),
				po.order.status === "draft" ? setPartsOf(db, data.id) : [],
			]);
		return {
			changes,
			...po,
			lines: po.lines.map((l) => ({
				...l,
				onHand: onHand.get(l.productId) ?? 0,
				// Every line's product has one; ?? only satisfies the Map type.
				stockRange: ranges.get(l.productId) ?? null,
			})),
			setParts,
			receipts,
			locations: ownedLocations,
			units,
			emailConfigured: emailConfigured(),
		};
	});

export type PurchaseOrderDetail = Awaited<ReturnType<typeof getPurchaseOrder>>;

export const createDraft = createServerFn({ method: "POST" })
	.validator(
		type({ supplierId: "number.integer > 0", "fromSuggestions?": "boolean" }),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		return data.fromSuggestions === false
			? openDraft(db, data.supplierId)
			: draftFromSuggestions(db, data.supplierId);
	});

// Brings a frozen draft up to date with what needs reordering today.
export const updateDraftFromSuggestions = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => updateFromSuggestions(getDb(), data.id));

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

// Moves one part of a set on a draft to its own supplier's draft.
export const moveSetPart = createServerFn({ method: "POST" })
	.validator(
		type({ lineId: "number.integer > 0", productId: "number.integer > 0" }),
	)
	.handler(async ({ data }) => movePartToSupplier(getDb(), data));

export const editDraft = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			"notes?": "string | null",
			"locationId?": "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => updateDraft(getDb(), data));

// Adds a product to a draft by SKU, at the smallest quantity its supplier sells.
export const addLineBySku = createServerFn({ method: "POST" })
	.validator(type({ purchaseOrderId: "number.integer > 0", sku: "string > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [product] = await db
			.select({
				id: products.id,
				minimum: productSuppliers.minimumQuantity,
			})
			.from(products)
			.leftJoin(productSuppliers, eq(productSuppliers.productId, products.id))
			.where(eq(products.sku, data.sku));
		if (!product) throw new PurchaseOrderError(`No product ${data.sku}`);
		await setDraftLine(db, {
			purchaseOrderId: data.purchaseOrderId,
			productId: product.id,
			quantity: product.minimum ?? 1,
		});
	});

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
		if (!link)
			throw new PurchaseOrderError("Set this product's supplier first");
		const purchaseOrderId = await openDraft(db, link.supplierId);
		const { added, line } = await addDraftLine(db, {
			purchaseOrderId,
			productId: data.productId,
			quantity: data.quantity ?? link.minimum,
		});
		return { added, purchaseOrderId, supplierName: link.supplierName, line };
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
					attachment: { filename, content: pdf },
				});
				return to;
			},
		});
		return { sentTo };
	});

export const receiveLine = createServerFn({ method: "POST" })
	.validator(
		type({ lineId: "number.integer > 0", quantity: "number.integer > 0" }),
	)
	.handler(async ({ data }) => receive(getDb(), data));

export const undoPurchaseReceipt = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => undoReceipt(getDb(), data.id));

export const closePurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => closeOrder(getDb(), data.id));

export const cancelPurchaseOrder = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => cancelOrder(getDb(), data.id));

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
			.groupBy(purchaseOrders.id, suppliers.name)
			.orderBy(purchaseOrders.expectedAt);
	},
);

export const listSuppliers = createServerFn({ method: "GET" }).handler(
	async () => supplierRows(getDb()),
);

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
		}),
	)
	.handler(async ({ data: { id: supplierId, ...values } }) =>
		updateSupplierDetails(getDb(), supplierId, values),
	);

// Who a product comes from, for its product page. Null when no supplier.
export const getProductSupplier = createServerFn({ method: "GET" })
	.validator(type({ productId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [link] = await db
			.select({
				supplierId: suppliers.id,
				supplierName: suppliers.name,
				supplierSku: productSuppliers.supplierSku,
				cost: productSuppliers.cost,
				unit: productSuppliers.unit,
				packSize: productSuppliers.packSize,
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
		return { link: link ?? null, open, units: await listUnits(db) };
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
