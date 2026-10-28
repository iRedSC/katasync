import { SHOP_TIME_ZONE } from "#/lib/format";
import { type Discount, lineCents } from "#/purchasing/discount";

// What we've bought from suppliers, worked out from PO lines. On its own and
// free of the database so the sums can be tested.

export type OrderedLine = {
	purchaseOrderId: number;
	supplierId: number;
	status: "suggested" | "draft" | "sent" | "closed" | "cancelled";
	sentAt: Date | null;
	productId: number;
	// In the line's unit; packSize turns it into single items.
	quantity: number;
	packSize: number;
	unitCost: number | null;
	discounts: Discount[];
};

// Bought: sent to the supplier and not cancelled. Drafts and suggestions
// haven't been asked for yet.
export const isBought = (l: OrderedLine): l is OrderedLine & { sentAt: Date } =>
	(l.status === "sent" || l.status === "closed") && l.sentAt !== null;

export type Spend = {
	// After each line's discounts.
	cents: number;
	// Single items, so cases and eaches add up.
	units: number;
	pos: number;
	// Lines nobody priced, left out of `cents`.
	unpriced: number;
};

// What these lines spent, from `since` on when given.
export function spendOf(lines: OrderedLine[], since?: Date): Spend {
	const pos = new Set<number>();
	let cents = 0;
	let units = 0;
	let unpriced = 0;
	for (const l of lines) {
		if (!isBought(l) || (since && l.sentAt < since)) continue;
		pos.add(l.purchaseOrderId);
		units += l.quantity * l.packSize;
		const c = lineCents(l, l.discounts);
		if (c === null) {
			if (l.quantity > 0) unpriced++;
		} else cents += c;
	}
	return { cents, units, pos: pos.size, unpriced };
}

// Each PO's total after discounts, in cents. Unpriced lines count as 0.
export function poCents(lines: OrderedLine[]) {
	const totals = new Map<number, number>();
	for (const l of lines)
		totals.set(
			l.purchaseOrderId,
			(totals.get(l.purchaseOrderId) ?? 0) + (lineCents(l, l.discounts) ?? 0),
		);
	return totals;
}

const monthKey = new Intl.DateTimeFormat("en-CA", {
	timeZone: SHOP_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
});
const monthLabel = new Intl.DateTimeFormat("en-US", {
	timeZone: SHOP_TIME_ZONE,
	month: "short",
});

// Spend in each of the last `months` calendar months, oldest first, this
// month last, in the shop's time zone. Months with nothing bought are 0.
export function monthlySpend(lines: OrderedLine[], now: Date, months = 12) {
	const buckets: { key: string; label: string; cents: number }[] = [];
	// This month is the shop's, which for a few hours a month isn't UTC's.
	const parts = monthKey.formatToParts(now);
	const part = (type: "year" | "month") =>
		Number(parts.find((p) => p.type === type)?.value);
	const year = part("year");
	const month = part("month") - 1;
	for (let i = months - 1; i >= 0; i--) {
		// Mid-month is the same month in every time zone.
		const at = new Date(Date.UTC(year, month - i, 15, 12));
		buckets.push({
			key: monthKey.format(at),
			label: monthLabel.format(at),
			cents: 0,
		});
	}
	const byKey = new Map(buckets.map((b) => [b.key, b]));
	for (const l of lines) {
		if (!isBought(l)) continue;
		const b = byKey.get(monthKey.format(l.sentAt));
		if (b) b.cents += lineCents(l, l.discounts) ?? 0;
	}
	return buckets;
}

// The products bought most, by single items or by spend, from `since` on.
export function topBought(
	lines: OrderedLine[],
	by: "units" | "cents",
	n: number,
	since?: Date,
) {
	const of = new Map<
		number,
		{ productId: number; units: number; cents: number }
	>();
	for (const l of lines) {
		if (!isBought(l) || (since && l.sentAt < since)) continue;
		const p = of.get(l.productId) ?? {
			productId: l.productId,
			units: 0,
			cents: 0,
		};
		p.units += l.quantity * l.packSize;
		p.cents += lineCents(l, l.discounts) ?? 0;
		of.set(l.productId, p);
	}
	return [...of.values()]
		.filter((p) => p[by] > 0)
		.sort((a, b) => b[by] - a[by] || a.productId - b.productId)
		.slice(0, n);
}
