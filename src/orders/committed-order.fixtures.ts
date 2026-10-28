import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { activate, channelOrder } from "#/inventory/commitments.fixtures";
import { consumeCommitments } from "#/inventory/commitments-consume";
import { restoreCommitments } from "#/inventory/commitments-restore";
import { postMovements } from "#/inventory/ledger";
import { addDispatch } from "#/test/db";
import { ingestOrder } from "./ingest";

// An order "#1001" in the store of 3 of the WRENCH product ($20, costing $8)
// and $10 shipping with committed stock, of which handoffs shipped `shipped`,
// then one more that was put back.
export async function committedOrder(
	db: Db,
	store: { id: number; wrench: number },
	shipped: number,
) {
	await activate(db);
	const [warehouse, retail] = await db
		.insert(schema.locations)
		.values([
			{ name: "Warehouse", kind: "owned" },
			{ name: "Retail", kind: "retail", posPrimary: true },
		])
		.returning();
	await db
		.update(schema.products)
		.set({ unitCost: 8 })
		.where(eq(schema.products.id, store.wrench));
	await postMovements(db, {
		lines: [
			{
				productId: store.wrench,
				locationId: warehouse.id,
				delta: 5,
				reason: "receipt",
			},
		],
	});
	const now = new Date();
	const [{ stockFrom }] = await db
		.update(schema.stores)
		.set({ stockFrom: new Date(now.getTime() - 86_400_000) })
		.where(eq(schema.stores.id, store.id))
		.returning();
	const { orderId } = await ingestOrder(
		db,
		{ id: store.id, stockFrom },
		channelOrder({ placedAt: now, sourceUpdatedAt: now }),
		{
			shipping: warehouse.id,
			store: retail.id,
			pos: retail.id,
			storeKeeps: 0,
		},
	);
	const [{ id: orderLineId }] = await db
		.select({ id: schema.orderLines.id })
		.from(schema.orderLines)
		.where(eq(schema.orderLines.orderId, orderId));
	await addDispatch(db, { orderIds: [orderId] });
	const ship = (quantity: number, fulfillmentKey: string) =>
		consumeCommitments(db, {
			orderId,
			lines: [{ orderLineId, quantity }],
			fulfillmentKey,
		});
	if (shipped > 0) await ship(shipped, "d1");
	await ship(1, "void");
	await restoreCommitments(db, { orderId, fulfillmentKey: "void" });
	return { orderId, orderLineId };
}
