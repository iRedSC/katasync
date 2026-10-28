import type {
	checkSupplierInvoice,
	recordSupplierInvoice,
} from "#/server/purchasing/invoices";

// One line as typed or pasted off the invoice.
export type Row = {
	key: number;
	item: string;
	quantity: string;
	unitCost: string;
};

// The invoice form as typed, every field still text.
export type Draft = {
	purchaseOrderId: number;
	number: string;
	invoicedOn: string;
	dueOn: string;
	total: string;
	freight: string;
	tax: string;
	credits: string;
	rows: readonly Row[];
};

export type HeaderField =
	| "number"
	| "invoicedOn"
	| "dueOn"
	| "total"
	| "freight"
	| "tax"
	| "credits";
export type RowField = "item" | "quantity" | "unitCost";

// What stops the invoice from being recorded: each header field, and each
// row's fields by the row's key.
export type Problems = {
	header: ReadonlySet<HeaderField>;
	rows: ReadonlyMap<number, ReadonlySet<RowField>>;
};

type CheckData = Parameters<typeof checkSupplierInvoice>[0]["data"];
type RecordData = Parameters<typeof recordSupplierInvoice>[0]["data"];

// A draft read whole: what to check as it's typed (the finished lines so far,
// or null before there's one), and either everything to record or what's in
// the way. Nothing typed is ever left out of a record: a row or charge that
// doesn't read is a problem, not skipped.
export type Reading = {
	check: CheckData | null;
	record:
		| { kind: "ready"; data: RecordData }
		| { kind: "invalid"; problems: Problems };
};

export const isBlank = (r: Row) =>
	!r.item.trim() && !r.quantity.trim() && !r.unitCost.trim();

// "$1,234.50" reads as 1234.5; anything else that isn't a number is null.
export function money(s: string) {
	const t = s.replace(/[$,\s]/g, "");
	return /^\d*\.?\d+$/.test(t) ? Number(t) : null;
}
export const count = (s: string) =>
	/^\d+$/.test(s.replace(/,/g, "").trim()) ? Number(s.replace(/,/g, "")) : null;

// Letters and digits only, as the server compares item numbers.
export const itemKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// An optional amount: blank is none, anything else must read as money.
function optional(
	s: string,
): { ok: true; value: number | undefined } | { ok: false } {
	if (s.trim() === "") return { ok: true, value: undefined };
	const value = money(s);
	return value === null ? { ok: false } : { ok: true, value };
}

// `ourSkus` are the PO's SKUs, keyed by itemKey; an item typed as one of them
// matches by SKU, any other by the supplier's item number.
export function readInvoice(
	draft: Draft,
	ourSkus: ReadonlySet<string>,
): Reading {
	const header = new Set<HeaderField>();
	const rows = new Map<number, Set<RowField>>();
	const lines: RecordData["lines"] & {} = [];
	draft.rows.forEach((r, i) => {
		if (isBlank(r)) return;
		const item = r.item.trim();
		const quantity = count(r.quantity);
		const unitCost = money(r.unitCost);
		const wrong = new Set<RowField>();
		if (!item) wrong.add("item");
		if (quantity === null) wrong.add("quantity");
		if (unitCost === null) wrong.add("unitCost");
		if (wrong.size > 0 || quantity === null || unitCost === null) {
			rows.set(r.key, wrong);
			return;
		}
		lines.push({
			line: i + 1,
			...(ourSkus.has(itemKey(item)) ? { sku: item } : { supplierSku: item }),
			quantity,
			unitCost,
		});
	});

	const number = draft.number.trim();
	const total = optional(draft.total);
	const freight = optional(draft.freight);
	const tax = optional(draft.tax);
	const credits = optional(draft.credits);
	if (!total.ok) header.add("total");
	if (!freight.ok) header.add("freight");
	if (!tax.ok) header.add("tax");
	if (!credits.ok) header.add("credits");
	const charges = {
		...(freight.ok && freight.value !== undefined
			? { freight: freight.value }
			: {}),
		...(tax.ok && tax.value !== undefined ? { tax: tax.value } : {}),
		...(credits.ok && credits.value ? { credits: credits.value } : {}),
	};

	const check: CheckData | null =
		lines.length === 0
			? null
			: {
					purchaseOrderId: draft.purchaseOrderId,
					...(number ? { number } : {}),
					...(total.ok && total.value !== undefined
						? { total: total.value }
						: {}),
					...charges,
					lines,
				};

	if (!number) header.add("number");
	if (!draft.invoicedOn) header.add("invoicedOn");
	if (total.ok && total.value === undefined) header.add("total");
	if (draft.dueOn && draft.dueOn < draft.invoicedOn) header.add("dueOn");
	if (
		header.size > 0 ||
		rows.size > 0 ||
		!total.ok ||
		total.value === undefined
	)
		return { check, record: { kind: "invalid", problems: { header, rows } } };
	return {
		check,
		record: {
			kind: "ready",
			data: {
				purchaseOrderId: draft.purchaseOrderId,
				number,
				invoicedOn: draft.invoicedOn,
				dueOn: draft.dueOn || null,
				total: total.value,
				...charges,
				lines,
			},
		},
	};
}
