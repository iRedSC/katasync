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
import { emailConfigured, sendEmail } from "#/purchasing/email";
import { documentFor, loadOrder, receivedByLine } from "#/purchasing/load";
import {
	addSuggestions,
	cancelOrder,
	closeOrder,
	draftFromSuggestions,
	markSent,
	openDraft,
	PurchaseOrderError,
	receive,
	setDraftLine,
	undoReceipt,
	updateDraft,
} from "#/purchasing/orders";
import { suggestPurchases } from "#/purchasing/reorder";

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
					ordered: sql<number>`coalesce(sum(${purchaseOrderLines.quantity}), 0)::int`,
					received: sql<number>`coalesce(sum(least(coalesce(${received.units}, 0), ${purchaseOrderLines.quantity})), 0)::int`,
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
		const [onHand, receipts, ownedLocations, toAdd] = await Promise.all([
			onHandOf(
				db,
				po.lines.map((l) => l.productId),
			),
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
			// On a draft: suggested products for this supplier not on it yet.
			po.order.status === "draft"
				? suggestPurchases(db).then((all) => {
						const onPo = new Set(po.lines.map((l) => l.productId));
						return (
							all
								.find((s) => s.supplierId === po.supplier.id)
								?.lines.filter((l) => !onPo.has(l.productId)).length ?? 0
						);
					})
				: 0,
		]);
		return {
			toAdd,
			...po,
			lines: po.lines.map((l) => ({
				...l,
				onHand: onHand.get(l.productId) ?? 0,
			})),
			receipts,
			locations: ownedLocations,
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

// Pulls what needs reordering into a draft, e.g. one started blank.
export const pullSuggestions = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => addSuggestions(getDb(), data.id));

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
		const { po, pdf, filename } = await documentFor(db, data.id);
		const to = po.supplier.email;
		if (!to)
			throw new PurchaseOrderError(
				`${po.supplier.name} has no email. Add one in Suppliers, or mark it sent.`,
			);
		const from = po.location.shipFromName ?? po.location.name;
		await markSent(db, {
			purchaseOrderId: data.id,
			sentTo: to,
			deliver: () =>
				sendEmail({
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
				}),
		});
		return { sentTo: to };
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
				ordered: sql<number>`sum(${purchaseOrderLines.quantity})::int`,
				received: sql<number>`coalesce(sum(least(coalesce(${received.units}, 0), ${purchaseOrderLines.quantity})), 0)::int`,
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
	async () => {
		const db = getDb();
		return db
			.select({
				supplier: suppliers,
				products: sql<number>`(select count(*) from ${productSuppliers} where ${productSuppliers.supplierId} = ${suppliers.id})::int`,
				openOrders: sql<number>`(select count(*) from ${purchaseOrders} where ${purchaseOrders.supplierId} = ${suppliers.id} and ${purchaseOrders.status} = 'sent')::int`,
			})
			.from(suppliers)
			.orderBy(suppliers.name);
	},
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
			paymentTerms: text,
			notes: text,
			poNotes: text,
			leadTimeDays: "1 <= number.integer <= 365",
			coverDays: "1 <= number.integer <= 365",
			minimumOrder: "number >= 0",
		}),
	)
	.handler(async ({ data: { id: supplierId, ...values } }) => {
		const blank = (v: string | null) => v?.trim() || null;
		await getDb()
			.update(suppliers)
			.set({
				...values,
				name: values.name.trim(),
				contactName: blank(values.contactName),
				email: blank(values.email),
				phone: blank(values.phone),
				paymentTerms: blank(values.paymentTerms),
				notes: blank(values.notes),
				poNotes: blank(values.poNotes),
			})
			.where(eq(suppliers.id, supplierId));
	});

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
		return { link: link ?? null, open };
	});

// Sets or changes who a product comes from. supplierId null removes it.
export const setProductSupplier = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			supplierId: "number.integer > 0 | null",
			"supplierSku?": "string | null",
			"cost?": "number >= 0 | null",
			"minimumQuantity?": "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		if (data.supplierId === null) {
			await db
				.delete(productSuppliers)
				.where(eq(productSuppliers.productId, data.productId));
			return;
		}
		const [product] = await db
			.select({ kind: products.kind })
			.from(products)
			.where(eq(products.id, data.productId));
		if (product?.kind === "bundle")
			throw new PurchaseOrderError(
				"Tool sets are bought as their parts; set suppliers on those",
			);
		const values = {
			supplierId: data.supplierId,
			...(data.supplierSku !== undefined
				? { supplierSku: data.supplierSku?.trim() || null }
				: {}),
			...(data.cost !== undefined ? { cost: data.cost } : {}),
			...(data.minimumQuantity !== undefined
				? { minimumQuantity: data.minimumQuantity }
				: {}),
		};
		await db
			.insert(productSuppliers)
			.values({ productId: data.productId, ...values })
			.onConflictDoUpdate({ target: productSuppliers.productId, set: values });
	});
