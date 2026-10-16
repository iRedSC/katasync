import { type } from "arktype";
import { count, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
	productSuppliers,
	products,
	purchaseUnits,
	suppliers,
} from "#/db/schema";
import { chunks, readCsv } from "#/import/sumtracker";
import { PurchaseOrderError } from "#/purchasing/orders";
import { EACH, unitName } from "#/purchasing/units";

// One-time import of Sumtracker's suppliers.csv and primary-suppliers.csv into
// a catalog that already has its products. Build the plan first, review its
// warnings, then apply it.

const supplierRow = type({
	code: "string > 0",
	currency: "'USD'",
	company_name: "string",
	first_name: "string",
	last_name: "string",
	payment_terms: "string",
	notes: "string",
	po_notes: "string",
	email: "string",
	phone: "string",
	address_line_1: "string",
	address_line_2: "string",
	city: "string",
	state: "string",
	country: "string",
	pincode: "string",
	lead_time: "string",
	"+": "delete",
});

const linkRow = type({
	sku: "string > 0",
	currency: "'USD'",
	supplier_code: "string > 0",
	is_primary: "'True' | 'False'",
	supplier_sku: "string",
	uom: "string",
	pack_size: "string",
	cost: "string",
	moq: "string",
	"+": "delete",
});

export type SupplierImportPlan = {
	suppliers: (typeof suppliers.$inferInsert)[];
	links: {
		sku: string;
		supplierCode: string;
		supplierSku: string | null;
		unit: string;
		packSize: number;
		// Per unit, not per product.
		cost: number | null;
		// Counted in the unit.
		minimumQuantity: number;
	}[];
	warnings: string[];
};

// What Sumtracker calls one of the product itself ("Per Unit" is what its
// export fills in when nobody picked a unit).
const EACH_NAMES = new Set([EACH, "UNIT", "PCS", "PER UNIT"]);

// The largest pack size the database column holds.
const MAX_PACK_SIZE = 2_147_483_647;

// Reads a link's unit and pack size. Anything that can't be a real unit falls
// back to EACH with a warning, so a bad cell never blocks the import or
// silently prices a case as one product. `fellBack` says the supplier's price
// was for terms that were thrown away.
function purchaseTerms(
	sku: string,
	uom: string,
	packSize: string,
	warnings: string[],
) {
	const each = { unit: EACH, packSize: 1, fellBack: false };
	const fallback = { ...each, fellBack: true };
	const blank = packSize.trim() === "";
	const count = blank ? 1 : Number(packSize);
	const wholePack =
		Number.isInteger(count) && count >= 1 && count <= MAX_PACK_SIZE;

	let unit: string | null = null;
	if (uom.trim() !== "") {
		try {
			unit = unitName(uom);
		} catch (e) {
			if (!(e instanceof PurchaseOrderError)) throw e;
			// The pack is still known, just not what it comes in.
			if (wholePack && count > 1) {
				warnings.push(
					`${sku}: ${e.message}; bought in PACK of ${count} instead`,
				);
				return { unit: "PACK", packSize: count, fellBack: false };
			}
			warnings.push(`${sku}: ${e.message}; bought in EACH instead`);
			return fallback;
		}
	}

	if (unit === null || EACH_NAMES.has(unit)) {
		if (blank || count <= 1) return each;
		if (wholePack) {
			// EACH is always one of the product, so a pack needs its own unit.
			warnings.push(
				`${sku}: ${uom.trim() || EACH} with a pack size of ${count}; bought in PACK of ${count}`,
			);
			return { unit: "PACK", packSize: count, fellBack: false };
		}
	} else if (!blank && wholePack) {
		return { unit, packSize: count, fellBack: false };
	}
	warnings.push(
		`${sku}: pack size "${packSize.trim()}" isn't a whole number from 1 to ${MAX_PACK_SIZE}; bought in EACH instead`,
	);
	return fallback;
}

// `catalog` is every product by SKU, so links can be checked before anything
// is written.
export function planSupplierImport(
	files: { suppliers: string; links: string },
	catalog: Map<
		string,
		{ kind: "simple" | "kit" | "bundle"; unitCost: number | null }
	>,
): SupplierImportPlan {
	const supplierRows = readCsv(files.suppliers, supplierRow, "suppliers.csv");
	const linkRows = readCsv(files.links, linkRow, "primary-suppliers.csv");
	const errors: string[] = [];
	const warnings: string[] = [];

	const planned = supplierRows.map((r) => {
		const minimum = minimumFromNotes(r.notes);
		if (minimum !== null)
			warnings.push(
				`${r.code}: minimum order set to $${minimum} from its notes ("${r.notes}")`,
			);
		const lead = Number(r.lead_time);
		return {
			code: r.code,
			name: r.company_name.trim() || r.code,
			contactName: [r.first_name, r.last_name].join(" ").trim() || null,
			email: r.email.trim() || null,
			phone: r.phone.trim() || null,
			address1: r.address_line_1.trim() || null,
			address2: r.address_line_2.trim() || null,
			city: r.city.trim() || null,
			region: r.state.trim() || null,
			postalCode: r.pincode.trim() || null,
			country: r.country.trim() || null,
			paymentTerms: r.payment_terms.trim() || null,
			notes: r.notes.trim() || null,
			poNotes: r.po_notes.trim() || null,
			...(r.lead_time.trim() && lead > 0 ? { leadTimeDays: lead } : {}),
			...(minimum !== null ? { minimumOrder: minimum } : {}),
		};
	});
	const codes = new Set(planned.map((s) => s.code));
	if (codes.size !== planned.length)
		errors.push("suppliers.csv has duplicate codes");
	const noEmail = planned.filter((s) => !s.email).map((s) => s.code);
	if (noEmail.length > 0)
		warnings.push(
			`No email for ${noEmail.join(", ")}; their POs can't be sent until one is added`,
		);

	const links: SupplierImportPlan["links"] = [];
	const seen = new Set<string>();
	const skipped = { bundle: [] as string[], unknown: [] as string[] };
	const casePriced: string[] = [];
	for (const r of linkRows) {
		const sku = r.sku.trim().replace(/^'/, "");
		if (r.is_primary !== "True") {
			warnings.push(`Skipped backup supplier ${r.supplier_code} for ${sku}`);
			continue;
		}
		if (!codes.has(r.supplier_code)) {
			errors.push(`${sku}: unknown supplier ${r.supplier_code}`);
			continue;
		}
		if (seen.has(sku)) {
			errors.push(`${sku} has more than one primary supplier`);
			continue;
		}
		seen.add(sku);
		const product = catalog.get(sku);
		if (!product) {
			skipped.unknown.push(sku);
			continue;
		}
		if (product.kind === "bundle") {
			skipped.bundle.push(sku);
			continue;
		}
		const { unit, packSize, fellBack } = purchaseTerms(
			sku,
			r.uom,
			r.pack_size,
			warnings,
		);
		// A zero cost in Sumtracker means nobody entered one.
		let cost: number | null = Number(r.cost) > 0 ? Number(r.cost) : null;
		// Per EACH, a price for a pack nobody could read would price every
		// product at the whole pack's price.
		if (fellBack && cost !== null) {
			warnings.push(
				`${sku}: ignored the supplier price $${cost}, which was for a pack that couldn't be read`,
			);
			cost = null;
		}
		// The cost is per unit, so it should be near the product's cost times
		// the pack size. Some are far off (a $140 "each" sponge that costs $2:
		// a case price filed under EACH). POs are in units, so those fall back
		// to the product's own cost.
		if (cost !== null && product.unitCost !== null) {
			const expected = product.unitCost * packSize;
			if (Math.max(cost / expected, expected / cost) > 2) {
				casePriced.push(
					`${sku} ($${cost} vs $${Math.round(expected * 10_000) / 10_000})`,
				);
				cost = null;
			}
		}
		const moq = Number(r.moq);
		links.push({
			sku,
			supplierCode: r.supplier_code,
			supplierSku: r.supplier_sku.trim() || null,
			unit,
			packSize,
			cost,
			minimumQuantity: Number.isInteger(moq) && moq > 0 ? moq : 1,
		});
	}
	if (skipped.unknown.length > 0)
		warnings.push(
			`Skipped ${skipped.unknown.length} links to SKUs katasync doesn't have: ${skipped.unknown.join(", ")}`,
		);
	if (skipped.bundle.length > 0)
		warnings.push(
			`Skipped ${skipped.bundle.length} links to tool sets, which are bought as their parts: ${skipped.bundle.join(", ")}`,
		);

	if (casePriced.length > 0)
		warnings.push(
			`Ignored ${casePriced.length} supplier prices over twice or under half the product's cost, probably case prices: ${casePriced.join(", ")}`,
		);

	const units = [...new Set(links.map((l) => l.unit))].filter(
		(u) => u !== EACH,
	);
	if (units.length > 0)
		warnings.push(
			`Units used, added if katasync doesn't have them yet: ${units.join(", ")}`,
		);

	if (errors.length > 0)
		throw new Error(`Supplier export is invalid:\n${errors.join("\n")}`);
	return { suppliers: planned, links, warnings };
}

// Sumtracker had no field for it, so minimums live in notes like
// "Free Shipping Min - $1500" or "SHIP MIN 900".
export function minimumFromNotes(notes: string): number | null {
	const match = /\bmin(?:imum)?\b\D{0,10}?([\d,]+(?:\.\d+)?)/i.exec(notes);
	if (!match) return null;
	const value = Number(match[1].replaceAll(",", ""));
	return value > 0 ? value : null;
}

// Writes the plan in one transaction. Refuses to run if any suppliers exist,
// so it can't be imported twice.
export async function applySupplierImport(db: Db, plan: SupplierImportPlan) {
	return db.transaction(async (tx) => {
		const [{ existing }] = await tx
			.select({ existing: count() })
			.from(suppliers);
		if (existing > 0)
			throw new Error(
				`Database already has ${existing} suppliers; import needs none`,
			);

		const rows = await tx.insert(suppliers).values(plan.suppliers).returning();
		const supplierIds = new Map(rows.map((s) => [s.code, s.id]));

		// Links point at units, so the ones the export uses must exist first.
		const wanted = [...new Set(plan.links.map((l) => l.unit))].filter(
			(u) => u !== EACH,
		);
		const created =
			wanted.length === 0
				? []
				: await tx
						.insert(purchaseUnits)
						.values(wanted.map((name) => ({ name })))
						.onConflictDoNothing()
						.returning({ name: purchaseUnits.name });

		const productIds = new Map<string, number>();
		for (const chunk of chunks(plan.links, 500)) {
			const found = await tx
				.select({ id: products.id, sku: products.sku })
				.from(products)
				.where(
					inArray(
						products.sku,
						chunk.map((l) => l.sku),
					),
				);
			for (const p of found) productIds.set(p.sku, p.id);
		}

		for (const chunk of chunks(plan.links, 500)) {
			await tx.insert(productSuppliers).values(
				chunk.map((l) => {
					const productId = productIds.get(l.sku);
					const supplierId = supplierIds.get(l.supplierCode);
					if (productId === undefined || supplierId === undefined)
						throw new Error(`${l.sku} or ${l.supplierCode} is missing`);
					return {
						productId,
						supplierId,
						supplierSku: l.supplierSku,
						unit: l.unit,
						packSize: l.packSize,
						// Sumtracker only has the one pack size.
						supplierCount: l.packSize,
						cost: l.cost,
						minimumQuantity: l.minimumQuantity,
					};
				}),
			);
		}
		return {
			suppliers: rows.length,
			links: plan.links.length,
			unitsCreated: created.map((u) => u.name).sort(),
		};
	});
}
