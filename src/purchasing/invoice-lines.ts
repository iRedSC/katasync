export type LineName = {
	sku: string;
	supplierSku: string | null;
	name: string;
	variantName: string | null;
};

export type InvoiceRef = {
	// Their line number, echoed back so differences are easy to find on paper.
	line?: number;
	// Our SKU, when the invoice shows it.
	sku?: string;
	// Their item number.
	supplierSku?: string;
	description?: string;
};

// Merchandise is billed at a price, so both its numbers are nonnegative. A
// deduction, such as a discount, is a credit: money taken off the total, never
// a negative price.
export type InvoiceLine =
	| (InvoiceRef & {
			kind: "merchandise";
			// In the PO line's unit, as the invoice counts: 12 packs, not 300 discs.
			quantity: number;
			unitCost: number;
			unit?: string;
			packSize?: number;
			amount?: number;
	  })
	| (InvoiceRef & {
			kind: "credit";
			// Dollars off the invoice.
			amount: number;
	  });

// Letters and digits only, lowercased: "TT-07TT-C" and "tt07ttc" agree.
export const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const describe = (l: Pick<LineName, "name" | "variantName">) =>
	l.variantName ? `${l.name} (${l.variantName})` : l.name;

export type Match<L> =
	| { line: L; by: "sku" | "supplier_sku" | "description" }
	| { line: null; reason: string };

// The PO lines an identifier names: the same spelling when any line has it,
// else the same letters and digits. Only one line may answer, so the caller
// checks the count.
function named<L extends LineName>(
	lines: L[],
	pick: (l: L) => string | null,
	wanted: string,
): L[] {
	const exact = lines.filter((l) => pick(l) === wanted);
	if (exact.length > 0) return exact;
	if (key(wanted) === "") return [];
	return lines.filter((l) => {
		const v = pick(l);
		return v !== null && key(v) === key(wanted);
	});
}

// Finds the PO line an invoice line bills for. Our SKU first, then theirs,
// then the description. Each must name exactly one line: one that fits two
// matches neither, and SKU and supplier SKU naming different lines is refused,
// rather than a guess.
export function findLine<L extends LineName>(
	lines: L[],
	inv: InvoiceRef,
): Match<L> {
	const bySku = inv.sku ? named(lines, (l) => l.sku, inv.sku) : [];
	const bySupplier = inv.supplierSku
		? named(lines, (l) => l.supplierSku, inv.supplierSku)
		: [];
	if (bySku.length > 1)
		return {
			line: null,
			reason: `SKU ${inv.sku} fits ${bySku.map((l) => l.sku).join(", ")}`,
		};
	if (bySupplier.length > 1)
		return {
			line: null,
			reason: `supplier SKU ${inv.supplierSku} fits ${bySupplier.map((l) => l.sku).join(", ")}`,
		};
	if (
		bySku.length === 1 &&
		bySupplier.length === 1 &&
		bySku[0] !== bySupplier[0]
	)
		return {
			line: null,
			reason: `SKU ${inv.sku} and supplier SKU ${inv.supplierSku} name different lines`,
		};
	if (bySku.length === 1) return { line: bySku[0], by: "sku" };
	if (bySupplier.length === 1)
		return { line: bySupplier[0], by: "supplier_sku" };
	if (inv.description) {
		const wanted = key(inv.description);
		const fits = lines.filter(
			(l) =>
				key(describe(l)) === wanted ||
				// Invoices often put the item number in front: "196003 - Hinge".
				(l.supplierSku && wanted === key(l.supplierSku + describe(l))),
		);
		if (fits.length === 1) return { line: fits[0], by: "description" };
		if (fits.length > 1)
			return {
				line: null,
				reason: `description fits ${fits.map((l) => l.sku).join(", ")}`,
			};
	}
	return { line: null, reason: "not on the PO" };
}

