import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { stockBlocker } from "./push";

// Turns a store's stock push on or off. Turning it on starts from a fresh
// read of the channel, so the first pass writes only what really differs.
// Refused while something would make every quantity wrong (stockBlocker).
export async function setStorePush(db: Db, storeId: number, on: boolean) {
	if (on) {
		const blocker = await stockBlocker(db);
		if (blocker) throw new Error(blocker);
	}
	const [store] = await db
		.update(stores)
		.set(
			on
				? { pushStock: true, stockReadAt: null, stockPushError: null }
				: { pushStock: false },
		)
		.where(eq(stores.id, storeId))
		.returning({ name: stores.name });
	if (!store) throw new Error(`Unknown store ${storeId}`);
	return store;
}
