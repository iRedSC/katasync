import { and, eq, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";

// One invoice the print page showed: the order, at the picking version its
// slip was read at (orders.picking_version).
export type PrintedInvoice = { orderId: number; version: number };

// Marks these invoices printed, each only if its order's picking work is
// still the version that was printed: a box bought, handed off, voided or
// refused since, a sync changing its lines, or its printed mark cleared bumps
// the version (drizzle/0183), and that newer work
// stays unprinted so Print all picks it up. Returns how many weren't
// recorded because they changed since printing.
export async function recordPrinted(
	db: Db,
	printed: PrintedInvoice[],
): Promise<{ changed: number }> {
	if (printed.length === 0) return { changed: 0 };
	const marked = await db
		.update(orders)
		.set({ invoicePrintedAt: new Date() })
		.where(
			or(
				...printed.map((p) =>
					and(eq(orders.id, p.orderId), eq(orders.pickingVersion, p.version)),
				),
			),
		)
		.returning({ id: orders.id });
	const ids = new Set(printed.map((p) => p.orderId));
	return { changed: ids.size - marked.length };
}
