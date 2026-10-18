import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { and, eq, or } from "drizzle-orm";
import { getDb } from "#/db/client";
import {
	productSuppliers,
	purchaseOrderLines,
	purchaseOrders,
	suppliers,
} from "#/db/schema";
import { type LeadTime, leadTimes } from "#/purchasing/forecast";
import { supplierRows } from "#/purchasing/load";
import {
	setProductSupplier as setProductSupplierLink,
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
