import type { ComponentProps } from "react";
import type { BulkChip } from "#/components/bulk-chip";
import type { OnPoChip } from "#/components/on-po-chip";
import { matchWarning } from "#/components/po-search";
import type { PurchaseTerms } from "#/components/purchase-unit";
import type { sortValuesOf } from "#/products/rows";
import type { Facets } from "#/products/search";
import {
	NUMBER,
	type SortColumns,
	type SortValue,
	TEXT,
} from "#/products/sort";
import { PRODUCT_SORTS } from "#/products/views";
import type { BrowseRow, PurchaseOrderMatch } from "#/server/purchasing";
import type { Line, Recommendation } from "../types";

// Every product column but supplier, which is the same for all of them, and
// the columns the table shows. Cost is what this supplier charges.
const { supplier: _supplier, ...productColumns } = PRODUCT_SORTS;
export const COLUMNS = {
	...productColumns,
	theirsku: { label: "Their SKU", ...TEXT },
	minimum: { label: "Minimum order", ...NUMBER },
	due: { label: "Due", asc: "soonest first", desc: "latest first" },
	qty: { label: "Qty", ...NUMBER },
	cost: { label: "Cost", ...NUMBER },
	amount: { label: "Amount", ...NUMBER },
} as const satisfies SortColumns<string>;
export type Key = keyof typeof COLUMNS;

const NO_VALUES = Object.fromEntries(
	Object.keys(COLUMNS).map((k) => [k, null]),
) as Record<Key, SortValue>;

// Where a row came from, which says how adding it works: a recommendation
// at its quantity, one of this supplier's products at their fewest, or a
// product someone else sells, found by the server's search.
export type Source =
	| { kind: "recommended"; rec: Recommendation }
	| { kind: "catalog"; row: BrowseRow }
	| { kind: "match"; match: PurchaseOrderMatch };

export type Candidate = {
	productId: number;
	sku: string;
	name: string;
	variantName: string | null;
	imageUrl: string | null;
	kind: Line["kind"];
	supplierSku: string | null;
	terms: PurchaseTerms | null;
	unitCost: number | null;
	// What Add puts on, in the supplier's units.
	quantity: number;
	packSize: number;
	due: Recommendation["due"] | null;
	onHand: number;
	range: Line["stockRange"];
	why: Line["why"];
	otherPos: ComponentProps<typeof OnPoChip>["pos"];
	bulk: { list: ComponentProps<typeof BulkChip>["list"]; unit: string } | null;
	critical: boolean;
	cheaperAt: Recommendation["cheaperAt"];
	warning: { text: string; blocks: boolean } | null;
	// What the typed codes match exactly: a scan lands on its product.
	codes: string[];
	// Null when it isn't on this supplier's list, so no filter can match it.
	facets: Facets | null;
	values: Record<Key, SortValue>;
	source: Source;
};

export type Prepared = {
	row: BrowseRow;
	facets: Facets;
	values: ReturnType<typeof sortValuesOf>;
};

function valuesOf(
	c: Omit<Candidate, "values">,
	base: Prepared["values"] | null,
) {
	return {
		...(base ?? NO_VALUES),
		name: c.name,
		sku: c.sku,
		theirsku: c.supplierSku,
		minimum: c.terms?.minimumQuantity ?? null,
		due: c.due === null ? null : c.due === "now" ? -1 : c.due,
		qty: c.quantity,
		onhand: c.onHand,
		velocity: c.why?.dailyDemand ?? null,
		cost: c.unitCost,
		amount: c.unitCost === null ? null : c.unitCost * c.quantity,
	};
}

function withValues(
	c: Omit<Candidate, "values">,
	base: Prepared["values"] | null,
): Candidate {
	return { ...c, values: valuesOf(c, base) };
}

function codesOf(...codes: (string | null | undefined)[]) {
	return codes.filter((c): c is string => !!c).map((c) => c.toLowerCase());
}

export function fromRec(r: Recommendation, p: Prepared | undefined): Candidate {
	return withValues(
		{
			productId: r.productId,
			sku: r.sku,
			name: r.name,
			variantName: r.variantName,
			imageUrl: r.imageUrl,
			kind: r.kind,
			supplierSku: r.supplierSku,
			terms: r,
			unitCost: r.kind === "bundle" ? null : r.unitCost,
			quantity: r.quantity,
			packSize: r.packSize,
			due: r.due,
			onHand: r.onHand,
			range: r.stockRange,
			why: r.why,
			otherPos: r.otherPos,
			bulk: r.bulk && { list: r.bulk, unit: r.unit },
			critical: r.critical,
			cheaperAt: r.cheaperAt,
			warning: null,
			codes: codesOf(r.sku, r.barcode, r.supplierSku),
			facets: p?.facets ?? null,
			source: { kind: "recommended", rec: r },
		},
		p?.values ?? null,
	);
}

export function fromRow(p: Prepared, sent: boolean): Candidate {
	const { row } = p;
	const t = row.terms;
	return withValues(
		{
			productId: row.id,
			sku: row.sku,
			name: row.name,
			variantName: row.variantName,
			imageUrl: row.imageUrl,
			kind: row.kind,
			supplierSku: t?.supplierSku ?? null,
			terms: t,
			unitCost: row.kind === "bundle" ? null : (t?.cost ?? null),
			// The supplier's fewest, as adding it puts on.
			quantity: t?.minimumQuantity ?? 1,
			packSize: t?.packSize ?? 1,
			due: null,
			onHand: row.onHand ?? 0,
			range: row.range,
			why: row.why,
			otherPos: row.openPos,
			bulk:
				t && t.breaks.length > 0
					? { list: { cost: t.cost, breaks: t.breaks }, unit: t.unit }
					: null,
			critical: false,
			cheaperAt: null,
			// Sets come as their parts on a sent PO, so add those.
			warning:
				sent && row.kind === "bundle"
					? { text: "Tool set: add the parts that came", blocks: true }
					: null,
			codes: codesOf(row.sku, row.barcode, t?.supplierSku),
			facets: p.facets,
			source: { kind: "catalog", row },
		},
		p.values,
	);
}

export function fromMatch(m: PurchaseOrderMatch, sent: boolean): Candidate {
	return withValues(
		{
			productId: m.productId,
			sku: m.sku,
			name: m.name,
			variantName: m.variantName,
			imageUrl: m.imageUrl,
			kind: m.kind,
			supplierSku: m.supplierSku,
			terms: null,
			unitCost: m.kind === "bundle" ? null : m.cost,
			quantity: 1,
			packSize: m.packSize ?? 1,
			due: null,
			onHand: m.onHand,
			range: null,
			why: null,
			otherPos: m.otherPos,
			bulk: null,
			critical: false,
			cheaperAt: null,
			warning: matchWarning(m, sent),
			codes: codesOf(m.sku, m.supplierSku),
			facets: null,
			source: { kind: "match", match: m },
		},
		null,
	);
}
