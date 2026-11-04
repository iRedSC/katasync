import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import type { OpenReads } from "#/shipping/live-open";

// Stand-ins for what Shopify and eBay say is still open (live-open.ts).

// A marketplace that agrees with what katasync synced: each line open for
// its quantity less its synced shipped count, all of it when unknown. db
// may be a getter, for a fake made before the test's database.
export function syncedOpen(db: Db | (() => Db)): OpenReads {
	const read = async (externalId: string) => {
		const rows = await (typeof db === "function" ? db() : db)
			.select({
				line: schema.orderLines.externalId,
				quantity: schema.orderLines.quantity,
				shipped: schema.orderLines.shippedQuantity,
			})
			.from(schema.orderLines)
			.innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
			.where(eq(schema.orders.externalId, externalId));
		return new Map(
			rows.map((r) => [r.line, Math.max(0, r.quantity - (r.shipped ?? 0))]),
		);
	};
	return { shopify: read, ebay: read };
}

// A marketplace whose open counts the test sets, by line external id, for
// every order. Each read is counted.
export function setOpen(open: Map<string, number>) {
	const reads = { count: 0 };
	const read = async () => {
		reads.count++;
		return new Map(open);
	};
	return { open, reads, as: { shopify: read, ebay: read } as OpenReads };
}
