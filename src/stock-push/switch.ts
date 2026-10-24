import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { stores } from "#/db/schema";
import { STOCK_WRITE_HOLD } from "./policy";
import { holdStore } from "./push";

export async function setStorePush(db: Db, storeId: number, on: false) {
	if (on !== false) throw new Error(STOCK_WRITE_HOLD);
	return db.transaction(async (tx) => {
		await holdStore(tx, storeId);
		const [store] = await tx
			.update(stores)
			.set({ pushStock: false })
			.where(eq(stores.id, storeId))
			.returning({ name: stores.name });
		if (!store) throw new Error(`Unknown store ${storeId}`);
		return store;
	});
}
