export const CURRENCY = "USD";
export type Currency = typeof CURRENCY;

const MAX_CENTS = Number.MAX_SAFE_INTEGER / 10_000;

export type StaffContext = { readonly actor?: string };

export const actorOf = (ctx: StaffContext) => ctx.actor ?? null;

export class MoneyError extends Error {
	name = "MoneyError";
}

export function centsOf(dollars: number, what = "Amount") {
	const cents = Math.round(dollars * 100);
	if (
		!Number.isFinite(dollars) ||
		Math.abs(dollars * 100 - cents) > 1e-6 ||
		Math.abs(cents) > MAX_CENTS
	)
		throw new MoneyError(`${what} must be whole cents, not ${dollars}`);
	return cents;
}

export function wholeCents(cents: number, what = "Amount") {
	if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS)
		throw new MoneyError(`${what} must be whole cents, not ${cents}`);
	return cents;
}

export function priceUnits(price: number, what = "Unit price") {
	const units = Math.round(price * 10_000);
	if (
		!Number.isFinite(price) ||
		price < 0 ||
		Math.abs(price * 10_000 - units) > 1e-4
	)
		throw new MoneyError(`${what} can have at most 4 decimals, not ${price}`);
	return units;
}

export function currencyOf(currency: string | undefined): Currency {
	if (currency === undefined || currency === CURRENCY) return CURRENCY;
	throw new MoneyError(`Only USD is supported, not ${currency}`);
}

export type BillablePoLine = {
	id: number;
	sku: string;
	packSize: number;
	receivedUnits: number;
	prices: number[];
};

export type MatchableLine =
	| {
			kind: "merchandise";
			position: number;
			poLineId: number | null;
			unmatchedReason: string | null;
			quantity: number;
			packSize: number;
			unitPrice: number;
			amountCents: number;
	  }
	| { kind: "credit"; position: number; amountCents: number };

export type MatchableInvoice = {
	id: number;
	totalCents: number;
	activeSince: Date;
	voided: boolean;
	itemization:
		| { kind: "legacy" }
		| { kind: "header_only" }
		| {
				kind: "itemized";
				freightCents: number;
				taxCents: number;
				lines: MatchableLine[];
		  };
};

export type Discrepancy =
	| { kind: "not_on_po"; position: number; reason: string }
	| {
			kind: "beyond_received";
			position: number;
			sku: string;
			billedItems: number;
			matchedItems: number;
			receivedItems: number;
			billedEarlierItems: number;
	  }
	| {
			kind: "price";
			position: number;
			sku: string;
			invoiceUnitPrice: number;
			poUnitPrice: number;
			overCents: number;
	  }
	| { kind: "unpriced_po_line"; position: number; sku: string }
	| {
			kind: "line_arithmetic";
			position: number;
			expectedCents: number;
			amountCents: number;
	  }
	| { kind: "total_arithmetic"; offCents: number };

export type LineAllocation = {
	position: number;
	poLineId: number;
	billedItems: number;
	matchedItems: number;
};

export type InvoiceMatch =
	| { kind: "void" }
	| { kind: "legacy" }
	| { kind: "header_only" }
	| { kind: "matched"; allocations: LineAllocation[] }
	| {
			kind: "exception";
			allocations: LineAllocation[];
			discrepancies: [Discrepancy, ...Discrepancy[]];
	  };

export type PoLineBilling = {
	poLineId: number;
	sku: string;
	receivedItems: number;
	matchedItems: number;
	billedItems: number;
};

export type Billing = {
	invoices: Map<number, InvoiceMatch>;
	lines: PoLineBilling[];
	unverifiedInvoices: number;
};

const queueOrder = (a: MatchableInvoice, b: MatchableInvoice) =>
	a.activeSince.getTime() - b.activeSince.getTime() || a.id - b.id;

const samePerItem = (
	price: number,
	pack: number,
	other: number,
	otherPack: number,
) =>
	priceUnits(price) * otherPack ===
	Math.round(other * 10_000) * pack;

export function lineAmountCents(quantity: number, unitPrice: number) {
	return Math.round((quantity * priceUnits(unitPrice)) / 100);
}

export function matchBilling(
	poLines: BillablePoLine[],
	invoices: MatchableInvoice[],
): Billing {
	const byId = new Map(poLines.map((l) => [l.id, l]));
	const left = new Map(
		poLines.map((l) => [l.id, Math.max(0, l.receivedUnits) * l.packSize]),
	);
	const matched = new Map(poLines.map((l) => [l.id, 0]));
	const billed = new Map(poLines.map((l) => [l.id, 0]));
	const result = new Map<number, InvoiceMatch>();
	let unverifiedInvoices = 0;

	for (const inv of [...invoices].sort(queueOrder)) {
		if (inv.voided) {
			result.set(inv.id, { kind: "void" });
			continue;
		}
		if (inv.itemization.kind !== "itemized") {
			unverifiedInvoices++;
			result.set(inv.id, { kind: inv.itemization.kind });
			continue;
		}
		const { lines, freightCents, taxCents } = inv.itemization;
		const discrepancies: Discrepancy[] = [];
		const allocations: LineAllocation[] = [];
		let linesCents = 0;
		for (const line of lines) {
			if (line.kind === "credit") {
				linesCents -= line.amountCents;
				continue;
			}
			linesCents += line.amountCents;
			const expectedCents = lineAmountCents(line.quantity, line.unitPrice);
			if (expectedCents !== line.amountCents)
				discrepancies.push({
					kind: "line_arithmetic",
					position: line.position,
					expectedCents,
					amountCents: line.amountCents,
				});
			const po = line.poLineId === null ? undefined : byId.get(line.poLineId);
			if (!po) {
				discrepancies.push({
					kind: "not_on_po",
					position: line.position,
					reason: line.unmatchedReason ?? "not on the PO",
				});
				continue;
			}
			const billedItems = line.quantity * line.packSize;
			const available = left.get(po.id) ?? 0;
			const matchedItems = Math.min(billedItems, available);
			const billedEarlierItems = billed.get(po.id) ?? 0;
			left.set(po.id, available - matchedItems);
			matched.set(po.id, (matched.get(po.id) ?? 0) + matchedItems);
			billed.set(po.id, billedEarlierItems + billedItems);
			allocations.push({
				position: line.position,
				poLineId: po.id,
				billedItems,
				matchedItems,
			});
			if (matchedItems < billedItems)
				discrepancies.push({
					kind: "beyond_received",
					position: line.position,
					sku: po.sku,
					billedItems,
					matchedItems,
					receivedItems: Math.max(0, po.receivedUnits) * po.packSize,
					billedEarlierItems,
				});
			const [listPrice] = po.prices;
			if (listPrice === undefined) {
				discrepancies.push({
					kind: "unpriced_po_line",
					position: line.position,
					sku: po.sku,
				});
				continue;
			}
			if (
				!po.prices.some((p) =>
					samePerItem(line.unitPrice, line.packSize, p, po.packSize),
				)
			)
				discrepancies.push({
					kind: "price",
					position: line.position,
					sku: po.sku,
					invoiceUnitPrice: line.unitPrice,
					poUnitPrice: listPrice,
					overCents:
						line.amountCents -
						Math.round((billedItems * listPrice * 100) / po.packSize),
				});
		}
		const offCents = inv.totalCents - (linesCents + freightCents + taxCents);
		if (offCents !== 0) discrepancies.push({ kind: "total_arithmetic", offCents });
		const [first, ...rest] = discrepancies;
		result.set(
			inv.id,
			first === undefined
				? { kind: "matched", allocations }
				: { kind: "exception", allocations, discrepancies: [first, ...rest] },
		);
	}

	return {
		invoices: result,
		lines: poLines.map((l) => ({
			poLineId: l.id,
			sku: l.sku,
			receivedItems: Math.max(0, l.receivedUnits) * l.packSize,
			matchedItems: matched.get(l.id) ?? 0,
			billedItems: billed.get(l.id) ?? 0,
		})),
		unverifiedInvoices,
	};
}

export function explainDiscrepancy(d: Discrepancy): string {
	switch (d.kind) {
		case "not_on_po":
			return `Line ${d.position}: ${d.reason}`;
		case "beyond_received":
			return `${d.sku}: billed ${d.billedItems}, only ${d.matchedItems} received and unbilled (${d.receivedItems} received, ${d.billedEarlierItems} billed before)`;
		case "price":
			return `${d.sku}: $${d.invoiceUnitPrice} vs PO $${d.poUnitPrice}`;
		case "unpriced_po_line":
			return `${d.sku}: PO has no price`;
		case "line_arithmetic":
			return `Line ${d.position}: amount is off by $${((d.amountCents - d.expectedCents) / 100).toFixed(2)}`;
		case "total_arithmetic":
			return `Total is off by $${(d.offCents / 100).toFixed(2)}`;
		default: {
			const unreachable: never = d;
			return unreachable;
		}
	}
}

export type InvoicePayment =
	| { kind: "void" }
	| { kind: "unknown"; totalCents: number; paidHereCents: number }
	| { kind: "unpaid"; totalCents: number }
	| {
			kind: "partial";
			totalCents: number;
			paidCents: number;
			openCents: number;
	  }
	| { kind: "paid"; totalCents: number; paidCents: number };

export function paymentState(input: {
	totalCents: number;
	voided: boolean;
	legacy: boolean;
	openingCents: number | null;
	appliedCents: number;
}): InvoicePayment {
	const { totalCents, appliedCents, openingCents } = input;
	if (input.voided) return { kind: "void" };
	if (input.legacy && openingCents === null && appliedCents < totalCents)
		return { kind: "unknown", totalCents, paidHereCents: appliedCents };
	const paidCents = (openingCents ?? 0) + appliedCents;
	if (paidCents >= totalCents) return { kind: "paid", totalCents, paidCents };
	if (paidCents === 0) return { kind: "unpaid", totalCents };
	return {
		kind: "partial",
		totalCents,
		paidCents,
		openCents: totalCents - paidCents,
	};
}

export function openCentsOf(payment: InvoicePayment) {
	switch (payment.kind) {
		case "void":
		case "paid":
			return 0;
		case "unknown":
			return payment.totalCents - payment.paidHereCents;
		case "unpaid":
			return payment.totalCents;
		case "partial":
			return payment.openCents;
		default: {
			const unreachable: never = payment;
			return unreachable;
		}
	}
}
