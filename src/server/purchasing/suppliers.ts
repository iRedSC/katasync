import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, desc, eq, or } from "drizzle-orm";
import { getDb } from "#/db/client";
import {
	catalogs,
	products,
	purchaseOrderLines,
	purchaseOrders,
	supplierOffers,
	suppliers,
} from "#/db/schema";
import { type LeadTime, leadTimes } from "#/purchasing/forecast";
import { supplierRows } from "#/purchasing/load";
import {
	setSupplierTerms as setTerms,
	updateSupplier as updateSupplierDetails,
} from "#/purchasing/suppliers";
import { listUnits } from "#/purchasing/units";

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
export function leadTimeOf(lead: Map<number, LeadTime>, supplierId: number) {
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

// Who sells a product, for its product page: its catalog, every supplier
// carrying that catalog with its terms (cheapest first, the one reorder buys
// from), and the POs it's on.
export const getProductSupplier = createServerFn({ method: "GET" })
	.validator(type({ productId: "number.integer > 0" }))
	.handler(async ({ data }) => {
		const db = getDb();
		const [[product], offers, open, units] = await Promise.all([
			db
				.select({
					catalogId: products.catalogId,
					catalogName: catalogs.name,
					catalogPhotoId: catalogs.photoId,
				})
				.from(products)
				.leftJoin(catalogs, eq(catalogs.id, products.catalogId))
				.where(eq(products.id, data.productId)),
			db
				.select({
					supplierId: suppliers.id,
					supplierName: suppliers.name,
					supplierSku: supplierOffers.supplierSku,
					cost: supplierOffers.cost,
					itemCost: supplierOffers.itemCost,
					unit: supplierOffers.unit,
					packSize: supplierOffers.packSize,
					supplierCount: supplierOffers.supplierCount,
					minimumQuantity: supplierOffers.minimumQuantity,
					cheapest: supplierOffers.cheapest,
				})
				.from(supplierOffers)
				.innerJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
				.where(eq(supplierOffers.productId, data.productId))
				.orderBy(desc(supplierOffers.cheapest), suppliers.name),
			db
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
				.orderBy(purchaseOrders.id),
			listUnits(db),
		]);
		if (!product) throw new Error("That product doesn't exist");
		const catalog =
			product.catalogId === null || product.catalogName === null
				? null
				: {
						id: product.catalogId,
						name: product.catalogName,
						photoId: product.catalogPhotoId,
					};
		return { catalog, offers, open, units };
	});

// A supplier's part number or price for a product it sells.
export const setSupplierTerms = createServerFn({ method: "POST" })
	.validator(
		type({
			productId: "number.integer > 0",
			supplierId: "number.integer > 0",
			"supplierSku?": "string | null",
			"cost?": "number >= 0 | null",
		}),
	)
	.handler(async ({ data }) => setTerms(getDb(), data));
