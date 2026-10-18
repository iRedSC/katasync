import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { createTestDb } from "#/test/db";

export const now = new Date("2026-10-10T12:00:00Z");
export const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

export type Seeded = {
	db: Db;
	warehouse: number;
	canam: number;
	store: number;
};

// Each test file calls this from its own beforeEach, so every test gets a fresh DB.
export async function createPurchasingDb(): Promise<Seeded> {
	const db = await createTestDb();
	const [{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	const [{ id: canam }] = await db
		.insert(schema.suppliers)
		.values({
			code: "CANAM",
			name: "CanAm",
			leadTimeDays: 10,
			coverDays: 20,
			minimumOrder: 100,
		})
		.returning();
	const [{ id: store }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shop" })
		.returning();
	return { db, warehouse, canam, store };
}

// Builders take the current test's DB and ids from `get`. The order counter
// lives in the test file that calls this, so each file keeps its own.
export function purchasingBuilders(get: () => Seeded) {
	let orderCount = 0;

	async function stock(productId: number, qty: number) {
		const { db, warehouse } = get();
		await postMovements(db, {
			lines: [
				{
					productId,
					locationId: warehouse,
					delta: qty,
					reason: "opening_balance",
				},
			],
		});
	}

	async function sell(
		productId: number,
		quantity: number,
		extra: Partial<typeof schema.orders.$inferInsert> = {},
	) {
		const { db, store } = get();
		const n = ++orderCount;
		const [order] = await db
			.insert(schema.orders)
			.values({
				storeId: store,
				externalId: `o${n}`,
				name: `#${n}`,
				placedAt: daysAgo(10),
				fulfillmentStatus: "FULFILLED",
				total: 1,
				sourceUpdatedAt: now,
				...extra,
			})
			.returning();
		await db.insert(schema.orderLines).values({
			orderId: order.id,
			externalId: `l${n}`,
			productId,
			title: "x",
			quantity,
			unitPrice: 100,
		});
	}

	async function supply(productId: number, cost: number | null, minimum = 1) {
		const { db, canam } = get();
		await db.insert(schema.productSuppliers).values({
			productId,
			supplierId: canam,
			supplierCount: 1,
			cost,
			minimumQuantity: minimum,
		});
	}

	async function getPo(id: number) {
		const { db } = get();
		const [po] = await db
			.select()
			.from(schema.purchaseOrders)
			.where(eq(schema.purchaseOrders.id, id));
		return po;
	}

	async function linesOf(id: number) {
		const { db } = get();
		return db
			.select()
			.from(schema.purchaseOrderLines)
			.where(eq(schema.purchaseOrderLines.purchaseOrderId, id))
			.orderBy(schema.purchaseOrderLines.productId);
	}

	return { stock, sell, supply, getPo, linesOf };
}
