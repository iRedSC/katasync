import { and, eq, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { plain } from "./to-ship";

// One invoice the print page showed: the order, at the picking version its
// slip was read at (orders.picking_version).
export type PrintedInvoice = { orderId: number; version: number };

// Marks these invoices printed, each only if its order is still plain
// (to-ship.ts) and what its invoice prints is still the version that was
// printed: a sync changing it bumps the version (drizzle/0183), and that newer work stays
// unprinted so Print all picks it up. An order no longer plain never counts
// as printed, so it isn't marked. Returns how many weren't recorded.
export async function recordPrinted(
	db: Db,
	printed: PrintedInvoice[],
): Promise<{ changed: number }> {
	if (printed.length === 0) return { changed: 0 };
	const marked = await db
		.update(orders)
		.set({ invoicePrintedAt: new Date() })
		.where(
			and(
				plain,
				or(
					...printed.map((p) =>
						and(eq(orders.id, p.orderId), eq(orders.pickingVersion, p.version)),
					),
				),
			),
		)
		.returning({ id: orders.id });
	const ids = new Set(printed.map((p) => p.orderId));
	return { changed: ids.size - marked.length };
}
