import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "#/db/client";
import { tiktokMissingOrders } from "#/db/schema";

// TikTok's detail answer sometimes leaves out an order the search found.
// Such an order is kept here and asked for by ID on every pass, apart from
// the search's update-time cursor, so the cursor can move on without
// leaving it behind however old its update. It goes once TikTok answers for
// it, or once MISSING_HOLD_DAYS pass since the first miss: one TikTok never
// returns isn't asked for forever.

export const MISSING_HOLD_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

export async function missingToAsk(db: Pick<Db, "select">, storeId: number) {
	const rows = await db
		.select({ orderId: tiktokMissingOrders.orderId })
		.from(tiktokMissingOrders)
		.where(eq(tiktokMissingOrders.storeId, storeId));
	return rows.map((r) => r.orderId);
}

// After a pass: forgets what TikTok answered for, keeps what it left out,
// and gives up on what it has left out for too long.
export async function settleMissing(
	db: Db,
	storeId: number,
	asked: string[],
	answered: Set<string>,
	now = new Date(),
): Promise<{ missing: string[]; gaveUp: string[] }> {
	const missing = asked.filter((id) => !answered.has(id));
	return db.transaction(async (tx) => {
		// Only what was kept: a first pass answers for thousands.
		const found = (await missingToAsk(tx, storeId)).filter((id) =>
			answered.has(id),
		);
		if (found.length > 0)
			await tx
				.delete(tiktokMissingOrders)
				.where(
					and(
						eq(tiktokMissingOrders.storeId, storeId),
						inArray(tiktokMissingOrders.orderId, found),
					),
				);
		if (missing.length === 0) return { missing, gaveUp: [] };
		await tx
			.insert(tiktokMissingOrders)
			.values(
				missing.map((orderId) => ({ storeId, orderId, firstMissedAt: now })),
			)
			.onConflictDoNothing();
		const gone = await tx
			.delete(tiktokMissingOrders)
			.where(
				and(
					eq(tiktokMissingOrders.storeId, storeId),
					inArray(tiktokMissingOrders.orderId, missing),
					lt(
						tiktokMissingOrders.firstMissedAt,
						new Date(now.getTime() - MISSING_HOLD_DAYS * DAY),
					),
				),
			)
			.returning({ orderId: tiktokMissingOrders.orderId });
		const gaveUp = gone.map((r) => r.orderId);
		return { missing: missing.filter((id) => !gaveUp.includes(id)), gaveUp };
	});
}
