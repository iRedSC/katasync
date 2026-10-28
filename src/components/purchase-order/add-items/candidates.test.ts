import { describe, expect, test } from "vitest";
import { type Remote, remoteFor } from "#/components/po-search";
import {
	type Facets,
	FIELDS,
	type Filter,
	parseQuery,
} from "#/products/search";
import type { BrowseRow, PurchaseOrderMatch } from "#/server/purchasing";
import { candidateRows, type Prepared, remoteWords } from "./candidates";

const facets = (text: string[], status: string[] = []): Facets => ({
	...(Object.fromEntries(
		FIELDS.filter((f) => f !== "inventory" && f !== "velocity").map((f) => [
			f,
			[],
		]),
	) as unknown as Omit<Facets, "text" | "inventory" | "velocity">),
	status,
	text,
	inventory: 0,
	velocity: 0,
});

// This supplier's product A, whose name holds B's barcode.
const a: Prepared = {
	row: {
		id: 1,
		sku: "A-1",
		name: "Knife 0123456789",
		variantName: null,
		imageUrl: null,
		kind: "simple",
		barcode: null,
		terms: null,
		onHand: 0,
		range: null,
		why: null,
		openPos: [],
	} as unknown as BrowseRow,
	facets: facets(["knife 0123456789", "a-1"], ["active"]),
	values: {} as Prepared["values"],
};
const prepared = new Map([[1, a]]);

// Someone else's product B, with that barcode.
const b = {
	productId: 2,
	sku: "B-1",
	name: "Blade",
	variantName: null,
	imageUrl: null,
	kind: "simple",
	barcode: "0123456789",
	supplierSku: null,
	cost: null,
	packSize: null,
	onHand: 0,
	otherPos: [],
	fromThisSupplier: false,
	supplierId: 9,
	supplierName: "Other",
	cheapest: false,
} as unknown as PurchaseOrderMatch;

const chip: Filter = {
	field: "status",
	value: "active",
	exclude: false,
	and: false,
	exact: true,
};

function rows(text: string, remote: Remote, chips: Filter[] = []) {
	return candidateRows({
		recs: [],
		prepared,
		remote,
		chips,
		q: parseQuery(text),
		sort: [],
		sent: false,
	}).map((c) => c.productId);
}

describe("candidateRows", () => {
	test("an off-supplier exact barcode leads a supplier partial match", () => {
		const remote = remoteFor(
			{ state: "done", query: "0123456789", results: [b] },
			"0123456789",
		);
		expect(rows("0123456789", remote)).toEqual([2, 1]);
	});

	test("an earlier query's matches never show while the next one runs", () => {
		const searching = remoteFor(
			{ state: "searching", query: "knife", results: [b] },
			"blade",
		);
		const late = remoteFor(
			{ state: "done", query: "knife", results: [b] },
			"blade",
		);
		expect(searching).toEqual({ state: "pending" });
		expect(late).toEqual({ state: "pending" });
		expect(rows("knife", searching)).toEqual([1]);
	});

	test("typed and chipped filters both keep off-supplier matches out", () => {
		expect(remoteWords(parseQuery("%active knife"), [])).toBe("");
		expect(remoteWords(parseQuery("knife"), [chip])).toBe("");
		expect(remoteWords(parseQuery("knife"), [])).toBe("knife");
		// Even results already in hand don't slip past the filter.
		const done: Remote = { state: "done", results: [b] };
		expect(rows("%active knife", done)).toEqual([1]);
		expect(rows("knife", done, [chip])).toEqual([1]);
	});

	test("a failed off-supplier search leaves this supplier's rows", () => {
		const remote = remoteFor(
			{ state: "failed", query: "knife", message: "Timed out" },
			"knife",
		);
		expect(remote).toEqual({ state: "failed", message: "Timed out" });
		expect(rows("knife", remote)).toEqual([1]);
	});
});
