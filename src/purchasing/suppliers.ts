import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productSuppliers, products, suppliers } from "#/db/schema";
import { PurchaseOrderError } from "#/purchasing/orders";

// Who each product is bought from, and the suppliers' own details.

// A supplier by its short code ("CANAM") or full name, ignoring case.
export async function supplierByRef(db: Db, ref: string) {
	const wanted = ref.trim().toLowerCase();
	const all = await db
		.select({ id: suppliers.id, code: suppliers.code, name: suppliers.name })
		.from(suppliers);
	const found = all.find(
		(s) => s.code.toLowerCase() === wanted || s.name.toLowerCase() === wanted,
	);
	if (!found)
		throw new PurchaseOrderError(
			`No supplier "${ref}". Suppliers: ${all.map((s) => s.code).join(", ")}`,
		);
	return found;
}

// Sets or changes who a product comes from. supplierId null removes it.
// Leaving out supplierSku or cost keeps what's there.
export async function setProductSupplier(
	db: Db,
	input: {
		productId: number;
		supplierId: number | null;
		supplierSku?: string | null;
		cost?: number | null;
	},
) {
	if (input.supplierId === null) {
		await db
			.delete(productSuppliers)
			.where(eq(productSuppliers.productId, input.productId));
		return;
	}
	if (input.cost != null && !(input.cost >= 0))
		throw new PurchaseOrderError(`Price can't be ${input.cost}`);
	const [product] = await db
		.select({ kind: products.kind })
		.from(products)
		.where(eq(products.id, input.productId));
	if (!product) throw new PurchaseOrderError("That product doesn't exist");
	if (product.kind === "bundle")
		throw new PurchaseOrderError(
			"Tool sets are bought as their parts; set suppliers on those",
		);
	const values = {
		supplierId: input.supplierId,
		...(input.supplierSku !== undefined
			? { supplierSku: input.supplierSku?.trim() || null }
			: {}),
		...(input.cost !== undefined ? { cost: input.cost } : {}),
	};
	await db
		.insert(productSuppliers)
		.values({ productId: input.productId, ...values })
		.onConflictDoUpdate({ target: productSuppliers.productId, set: values });
}

export type SupplierFields = {
	name: string;
	contactName: string | null;
	email: string | null;
	phone: string | null;
	address1: string | null;
	address2: string | null;
	city: string | null;
	region: string | null;
	postalCode: string | null;
	country: string | null;
	paymentTerms: string | null;
	notes: string | null;
	poNotes: string | null;
	leadTimeDays: number;
	coverDays: number;
	minimumOrder: number;
};

// Changes any of a supplier's details. Blank text is stored as nothing.
export async function updateSupplier(
	db: Db,
	id: number,
	fields: Partial<SupplierFields>,
) {
	const blank = (v: string | null | undefined) =>
		v === undefined ? undefined : v?.trim() || null;
	for (const key of ["leadTimeDays", "coverDays"] as const) {
		const days = fields[key];
		if (
			days !== undefined &&
			!(Number.isInteger(days) && days >= 1 && days <= 365)
		)
			throw new PurchaseOrderError(`${key} must be 1 to 365 days, got ${days}`);
	}
	if (fields.minimumOrder !== undefined && !(fields.minimumOrder >= 0))
		throw new PurchaseOrderError(
			`Minimum order can't be ${fields.minimumOrder}`,
		);
	if (fields.name !== undefined && fields.name.trim() === "")
		throw new PurchaseOrderError("A supplier needs a name");
	const set = Object.fromEntries(
		Object.entries({
			...fields,
			name: fields.name?.trim(),
			contactName: blank(fields.contactName),
			email: blank(fields.email),
			phone: blank(fields.phone),
			address1: blank(fields.address1),
			address2: blank(fields.address2),
			city: blank(fields.city),
			region: blank(fields.region),
			postalCode: blank(fields.postalCode),
			country: blank(fields.country),
			paymentTerms: blank(fields.paymentTerms),
			notes: blank(fields.notes),
			poNotes: blank(fields.poNotes),
		}).filter(([, v]) => v !== undefined),
	);
	if (Object.keys(set).length === 0) return;
	const updated = await db
		.update(suppliers)
		.set(set)
		.where(eq(suppliers.id, id))
		.returning({ id: suppliers.id });
	if (updated.length === 0) throw new PurchaseOrderError("No such supplier");
}
