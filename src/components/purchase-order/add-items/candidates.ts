import type { ComponentProps } from "react";
import type { BulkChip } from "#/components/bulk-chip";
import type { OnPoChip } from "#/components/on-po-chip";
import { matchWarning, type Remote } from "#/components/po-search";
import type { PurchaseTerms } from "#/components/purchase-unit";
import type { sortValuesOf } from "#/products/rows";
import {
	compile,
	type Facets,
	type Filter,
	type parseQuery,
} from "#/products/search";
import {
	isColumn,
	NUMBER,
	type Sort,
	type SortColumns,
	type SortValue,
	sortRows,
	TEXT,
	withTerm,
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
	sales: { label: "Sales (30 days)", ...NUMBER },
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
		sales: c.why?.sales.d30 ?? null,
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
			cheaperAt: null,
			warning: matchWarning(m, sent),
			codes: codesOf(m.sku, m.barcode, m.supplierSku),
			facets: null,
			source: { kind: "match", match: m },
		},
		null,
	);
}

type Query = ReturnType<typeof parseQuery>;

// A status only this list knows: whether the product is already on this
// PO. It isn't in any product's facets, since lines come and go while the
// facets are built once per load; onPoShown applies it instead, so it
// never counts as searching and never turns off other suppliers' matches.
export const ON_PO = "on this PO";
export const NOT_ON_PO: Filter = {
	field: "status",
	value: ON_PO,
	exclude: true,
	and: false,
	exact: true,
};
export const isOnPoFilter = (f: Filter) =>
	f.field === "status" && f.value.toLowerCase() === ON_PO.toLowerCase();

// The query and chips with the on-PO filter taken out, for everything else.
function rest(q: Query, chips: Filter[]) {
	return {
		q: { ...q, filters: q.filters.filter((f) => !isOnPoFilter(f)) },
		chips: chips.filter((f) => !isOnPoFilter(f)),
	};
}

// What to ask the server about anyone else's products: the words, but only
// with no filter typed or chipped, since only this supplier's list can
// answer a filter.
export function remoteWords(query: Query, all: Filter[]) {
	const { q, chips } = rest(query, all);
	return chips.length === 0 && q.filters.length === 0 ? q.words.join(" ") : "";
}

// Anything typed or chipped, a sort included, searches this supplier's list.
export function isSearching(query: Query, all: Filter[]) {
	const { q, chips } = rest(query, all);
	return (
		chips.length > 0 ||
		q.words.length > 0 ||
		q.filters.length > 0 ||
		q.sorts.length > 0
	);
}

// The rows to show, first row first, as Enter takes it: those below, in the
// header's or the box's sort when there is one. Unsorted, a code typed or
// scanned whole leads.
export function candidateRows({
	recs,
	prepared,
	remote,
	chips,
	q,
	sort,
	sent,
}: {
	recs: Recommendation[];
	prepared: ReadonlyMap<number, Prepared>;
	remote: Remote;
	chips: Filter[];
	q: Query;
	sort: Sort<Key>;
	sent: boolean;
}): Candidate[] {
	({ q, chips } = rest(q, chips));
	const found = isSearching(q, chips)
		? searched({ recs, prepared, remote, chips, q, sent })
		: everything(recs, prepared, sent);
	// A sort still being typed applies once it names a column exactly.
	const by = q.sorts.reduce<Sort<Key>>(
		(s, t) =>
			isColumn(t.value, COLUMNS)
				? withTerm(s, { key: t.value, desc: t.desc })
				: s,
		sort,
	);
	// Ties fall back to name, never to where a row came from: adding a
	// recommendation turns it into the supplier's own row, and it must stay
	// where it was rather than jump to the end of the list.
	if (by.length > 0)
		return sortRows(
			found,
			by.some((t) => t.key === "name")
				? by
				: [...by, { key: "name", desc: false }],
			(c) => c.values,
		);
	const code = q.words.join(" ").toLowerCase();
	const exact = (c: Candidate) => code !== "" && c.codes.includes(code);
	return [...found.filter(exact), ...found.filter((c) => !exact(c))];
}

// An empty box: the recommendations first, in their rank, then the rest of
// what this supplier sells, as soon as their list has come.
function everything(
	recs: Recommendation[],
	prepared: ReadonlyMap<number, Prepared>,
	sent: boolean,
): Candidate[] {
	const recIds = new Set(recs.map((r) => r.productId));
	return [
		...recs.map((r) => fromRec(r, prepared.get(r.productId))),
		...[...prepared.values()]
			.filter((p) => !recIds.has(p.row.id))
			.map((p) => fromRow(p, sent)),
	];
}

// The recommendations and this supplier's products the query matches, then
// the server's finished matches for this very query, none of them when a
// filter is set.
function searched({
	recs,
	prepared,
	remote,
	chips,
	q,
	sent,
}: {
	recs: Recommendation[];
	prepared: ReadonlyMap<number, Prepared>;
	remote: Remote;
	chips: Filter[];
	q: Query;
	sent: boolean;
}): Candidate[] {
	const recIds = new Set(recs.map((r) => r.productId));
	const filtered = chips.length > 0 || q.filters.length > 0;
	const matches = remote.state === "done" && !filtered ? remote.results : [];
	const matcher = compile([...chips, ...q.filters], q.words);
	const found = [
		...recs.flatMap((r) => {
			const p = prepared.get(r.productId);
			return p ? [fromRec(r, p)] : [];
		}),
		...[...prepared.values()]
			.filter((p) => !recIds.has(p.row.id))
			.map((p) => fromRow(p, sent)),
	].filter((c) => c.facets !== null && matcher.matches(c.facets));
	found.push(
		...matches
			.filter((m) => !prepared.has(m.productId))
			.map((m) => fromMatch(m, sent)),
	);
	return found;
}

// What the on-PO filter leaves showing: `%!on this PO` hides products
// already on the PO, `%on this PO` shows only them. Ones added from this
// list since it last changed stay either way: a row just added stays where
// it was, saying Added, instead of vanishing from under the pointer.
export function onPoShown(
	rows: Candidate[],
	filters: Filter[],
	onPo: ReadonlyMap<number, number>,
	kept: ReadonlySet<number>,
): Candidate[] {
	const fs = filters.filter(isOnPoFilter);
	const hide = fs.some((f) => f.exclude);
	const only = fs.some((f) => !f.exclude);
	return rows.filter((c) => {
		if (kept.has(c.productId)) return true;
		const on = onPo.has(c.productId);
		return !(hide && on) && !(only && !on);
	});
}

// The line a whole code typed or scanned names, when its product is already
// on the PO, whether or not the on-PO filter shows it: a scan of something
// already ordered opens its line rather than adding whatever else matched.
export function scannedLine(
	rows: Candidate[],
	q: Query,
	onPo: ReadonlyMap<number, number>,
): { candidate: Candidate; lineId: number } | null {
	const code = q.words.join(" ").toLowerCase();
	if (code === "") return null;
	for (const c of rows) {
		const lineId = onPo.get(c.productId);
		if (lineId !== undefined && c.codes.includes(code))
			return { candidate: c, lineId };
	}
	return null;
}
