import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { productComponents, supplierOffers, suppliers } from "#/db/schema";
import { setOfferTerms } from "#/purchasing/catalogs";
import { PurchaseOrderError } from "#/purchasing/orders";

// The suppliers' own details, and their terms for what they sell.

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

// Sets a supplier's part number or price for a product it sells. Leaving
// either out keeps what's there.
export async function setSupplierTerms(
	db: Db,
	input: {
		productId: number;
		supplierId: number;
		supplierSku?: string | null;
		cost?: number | null;
	},
) {
	if (input.cost != null && !(input.cost >= 0))
		throw new PurchaseOrderError(`Price can't be ${input.cost}`);
	await db.transaction((tx) =>
		setOfferTerms(tx, input.productId, input.supplierId, {
			...(input.supplierSku !== undefined
				? { supplierSku: input.supplierSku?.trim() || null }
				: {}),
			...(input.cost !== undefined ? { cost: input.cost } : {}),
		}),
	);
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
	criticalThreshold: number;
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
	const threshold = fields.criticalThreshold;
	if (
		threshold !== undefined &&
		!(Number.isInteger(threshold) && threshold >= 1)
	)
		throw new PurchaseOrderError(
			`Critical products to send must be a whole number from 1, got ${threshold}`,
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

// Who a tool set is ordered from: the supplier most of its parts are bought
// from (each part's cheapest), ties going alphabetically. A set has no supplier of its own; it goes on that
// supplier's draft as one line, and sending the PO turns it into its parts.
// Sets whose parts have no suppliers are left out.
export async function setSuppliers(db: Db, setIds?: number[]) {
	const rows = await db
		.select({
			setId: productComponents.parentProductId,
			supplierId: suppliers.id,
			name: suppliers.name,
			parts: sql<number>`count(*)::int`,
		})
		.from(productComponents)
		.innerJoin(
			supplierOffers,
			and(
				eq(supplierOffers.productId, productComponents.componentProductId),
				eq(supplierOffers.cheapest, true),
			),
		)
		.innerJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
		.where(
			setIds ? inArray(productComponents.parentProductId, setIds) : undefined,
		)
		.groupBy(productComponents.parentProductId, suppliers.id, suppliers.name);
	const best = new Map<number, { id: number; name: string; parts: number }>();
	for (const r of rows) {
		const had = best.get(r.setId);
		if (
			!had ||
			r.parts > had.parts ||
			(r.parts === had.parts && r.name.localeCompare(had.name) < 0)
		)
			best.set(r.setId, { id: r.supplierId, name: r.name, parts: r.parts });
	}
	return new Map(
		[...best].map(([id, { id: sid, name }]) => [id, { id: sid, name }]),
	);
}

// Fills in a supplier's part numbers for products it sells, e.g. from an
// invoice. Only products this supplier sells change (it carries their
// catalog), so its part number can't land on something it doesn't. A
// product that already has a different number keeps it unless `replace`.
export async function fillSupplierSkus(
	db: Db,
	input: {
		supplierId: number;
		entries: { productId: number; sku: string; supplierSku: string }[];
		replace: boolean;
	},
) {
	const result = {
		filled: [] as { sku: string; supplierSku: string; was: string | null }[],
		unchanged: [] as string[],
		kept: [] as { sku: string; ours: string; given: string }[],
		skipped: [] as { sku: string; reason: string }[],
	};
	await db.transaction(async (tx) => {
		for (const e of input.entries) {
			const given = e.supplierSku.trim();
			const [offer] = await tx
				.select({ supplierSku: supplierOffers.supplierSku })
				.from(supplierOffers)
				.where(
					and(
						eq(supplierOffers.productId, e.productId),
						eq(supplierOffers.supplierId, input.supplierId),
					),
				);
			if (!given)
				result.skipped.push({ sku: e.sku, reason: "empty part number" });
			else if (!offer)
				result.skipped.push({
					sku: e.sku,
					reason:
						"this supplier doesn't sell it (catalog not carried, or marked unavailable)",
				});
			else if (offer.supplierSku === given) result.unchanged.push(e.sku);
			else if (offer.supplierSku && !input.replace)
				result.kept.push({ sku: e.sku, ours: offer.supplierSku, given });
			else {
				await setOfferTerms(tx, e.productId, input.supplierId, {
					supplierSku: given,
				});
				result.filled.push({
					sku: e.sku,
					supplierSku: given,
					was: offer.supplierSku,
				});
			}
		}
	});
	return result;
}
