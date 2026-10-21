import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders, orderTaxes } from "#/db/schema";

// Sales tax on one order, as its channel reports it. Who remits it decides
// whether it's ours to file, so every adapter has to say.
export type OrderTax = {
	remittedBy: NonNullable<typeof orders.$inferSelect.taxRemittedBy>;
	lines: TaxLine[];
};
export type TaxLine = {
	jurisdiction: string;
	// A fraction, 0.0725 for 7.25%.
	rate: number | null;
	amount: number;
};

// Builds tax lines, leaving out amounts that round to nothing (the table
// refuses zero) and folding together lines with the same jurisdiction and
// rate, as a split order lists the same tax once per item.
export function taxLines(lines: TaxLine[]): TaxLine[] {
	const merged = new Map<string, TaxLine>();
	for (const line of lines) {
		const key = `${line.jurisdiction}\u0000${line.rate ?? ""}`;
		const found = merged.get(key);
		if (found) found.amount += line.amount;
		else merged.set(key, { ...line });
	}
	return [...merged.values()]
		.map((l) => ({ ...l, amount: Math.round(l.amount * 100) / 100 }))
		.filter((l) => l.amount !== 0);
}

// Replaces what's saved for the order's tax with what the channel says now.
// Call it inside a transaction, so a failure never leaves the order marked
// as read with its lines missing.
export async function saveTax(db: Db, orderId: number, tax: OrderTax) {
	await db
		.update(orders)
		.set({ taxRemittedBy: tax.remittedBy })
		.where(eq(orders.id, orderId));
	await db.delete(orderTaxes).where(eq(orderTaxes.orderId, orderId));
	const lines = taxLines(tax.lines);
	if (lines.length > 0)
		await db.insert(orderTaxes).values(lines.map((l) => ({ ...l, orderId })));
}
