import type { BrowseRow } from "#/components/po-browse";
import type { Line, Recommendation } from "./types";

// The server lists lines by product name, then variant.
export const byName = (a: Line, b: Line) =>
	a.name.localeCompare(b.name) ||
	(a.variantName ?? "").localeCompare(b.variantName ?? "");

// A recommendation as the line adding it makes: the supplier's terms and
// price (a tool set has none of its own), on a draft, nothing received.
export function recommendedLine(
	r: Recommendation,
	id: number,
	supplierId: number,
): Line {
	return {
		id,
		productId: r.productId,
		sku: r.sku,
		kind: r.kind,
		name: r.name,
		variantName: r.variantName,
		imageUrl: r.imageUrl,
		barcode: r.barcode,
		supplierSku: r.supplierSku,
		unit: r.unit,
		packSize: r.packSize,
		supplierCount: r.supplierCount,
		minimumQuantity: r.minimumQuantity,
		linkSupplierId: supplierId,
		defaultUnit: r.unit,
		defaultPackSize: r.packSize,
		defaultSupplierCount: r.supplierCount,
		defaultMinimum: r.minimumQuantity,
		quantity: r.quantity,
		unitCost: r.kind === "bundle" ? null : r.unitCost,
		sentQuantity: null,
		sentUnitCost: null,
		receivingNote: null,
		received: 0,
		onHand: r.onHand,
		stockRange: r.stockRange,
		why: r.why,
		// The reload says what today's suggestion wants; until then, nothing.
		wants: null,
		locked: false,
		discounts: [],
		sentDiscounts: [],
	};
}

// A product from Browse as the line adding it makes: the supplier's fewest,
// on their terms and price, falling back to ours per unit; a tool set has no
// price of its own. Nothing received or sent yet.
export function browseLine(
	row: BrowseRow,
	id: number,
	supplierId: number,
): Line {
	const t = row.terms;
	const unit = t?.unit ?? "EACH";
	const packSize = t?.packSize ?? 1;
	const supplierCount = t?.supplierCount ?? 1;
	const minimumQuantity = t?.minimumQuantity ?? 1;
	return {
		id,
		productId: row.id,
		sku: row.sku,
		kind: row.kind,
		name: row.name,
		variantName: row.variantName,
		imageUrl: row.imageUrl,
		// Browse doesn't load barcodes; the reload brings it.
		barcode: null,
		supplierSku: t?.supplierSku ?? null,
		unit,
		packSize,
		supplierCount,
		minimumQuantity,
		linkSupplierId: supplierId,
		defaultUnit: unit,
		defaultPackSize: packSize,
		defaultSupplierCount: supplierCount,
		defaultMinimum: minimumQuantity,
		quantity: minimumQuantity,
		unitCost:
			row.kind === "bundle"
				? null
				: (t?.cost ?? (row.unitCost === null ? null : row.unitCost * packSize)),
		sentQuantity: null,
		sentUnitCost: null,
		receivingNote: null,
		received: 0,
		onHand: row.onHand ?? 0,
		stockRange: row.range,
		why: row.why,
		// The reload says what today's suggestion wants; until then, nothing.
		wants: null,
		locked: false,
		discounts: [],
		sentDiscounts: [],
	};
}
