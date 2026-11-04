import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { orders } from "#/db/schema";
import { needsShipping, remainingUnknown } from "#/orders/to-ship";

// Orders still to ship whose marketplace hasn't said what shipped can't be
// packed, and a sync pass reads only what changed, so one the marketplace
// never touches again would stay stuck. Each pass reads a few of them again
// by id, the longest unasked first. Every attempt is stamped as it's taken,
// whether the read works or not, so ones that keep failing go to the back
// and every one comes round.
const PER_PASS = 10;

export type UnknownShipped = { externalId: string; name: string };

// The store's orders to read again, claimed for this pass: synced before it
// began, so the ones it just read aren't read twice. Claimed by stamping
// them in the same statement that picks them, skipping rows another pass
// holds, so two passes at once don't ask for the same orders.
export async function unknownShippedOrders(
	db: Db,
	storeId: number,
	before: Date,
): Promise<UnknownShipped[]> {
	const picked = db
		.select({ id: orders.id })
		.from(orders)
		.where(
			and(
				eq(orders.storeId, storeId),
				needsShipping,
				remainingUnknown,
				lt(orders.syncedAt, before),
			),
		)
		.orderBy(
			sql`${orders.shippedCheckedAt} asc nulls first`,
			orders.syncedAt,
			orders.id,
		)
		.limit(PER_PASS)
		.for("update", { skipLocked: true });
	return db
		.update(orders)
		.set({ shippedCheckedAt: new Date() })
		.where(inArray(orders.id, picked))
		.returning({ externalId: orders.externalId, name: orders.name });
}

// Reads each one again with the channel's own one-order read, which ingests
// it as any sync would and returns its problems. One failing is reported and
// the rest still run.
export async function rereadUnknownShipped(
	db: Db,
	storeId: number,
	before: Date,
	read: (order: UnknownShipped) => Promise<string[]>,
): Promise<string[]> {
	const problems: string[] = [];
	for (const order of await unknownShippedOrders(db, storeId, before)) {
		try {
			problems.push(...(await read(order)));
		} catch (err) {
			problems.push(
				`${order.name}: couldn't be read again for what shipped (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}
	return problems;
}
