import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { postMovements } from "#/inventory/ledger";
import { setRecipe } from "#/inventory/recipes";
import { createProduct, createTestDb } from "#/test/db";
import { receiveReturn, undoReturns } from "./returns";

let db: Db;
let warehouse: number;
let orderId: number;

async function onHand(productId: number) {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, productId));
	return row?.onHand ?? 0;
}

// A shipped order selling `quantity` of the product, after its sale took
// stock (10 on the shelf before).
async function shippedOrder(
	productId: number | null,
	quantity: number,
	extra: Partial<typeof schema.orders.$inferInsert> = {},
) {
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: `Store ${Math.random()}` })
		.returning();
	[{ id: orderId }] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: `gid://shopify/Order/${Math.random()}`,
			name: "#1001",
			placedAt: new Date(),
			fulfillmentStatus: "FULFILLED",
			total: 40,
			sourceUpdatedAt: new Date(),
			...extra,
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId,
			externalId: "line-1",
			productId,
			sku: "WRENCH",
			title: "Wrench",
			quantity,
			unitPrice: 20,
		})
		.returning();
	return line.id;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
});

describe("receiveReturn", () => {
	test("restocked units go back on the shelf, and Undo takes them off", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const lineId = await shippedOrder(wrench, 2);
		const { ids } = await receiveReturn(db, {
			orderId,
			lines: [{ lineId, quantity: 2 }],
			restock: true,
		});
		expect(await onHand(wrench)).toBe(2);
		await undoReturns(db, ids);
		expect(await onHand(wrench)).toBe(0);
		expect(await db.select().from(schema.orderReturns)).toEqual([]);
	});

	test("written-off units are recorded without moving stock", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const lineId = await shippedOrder(wrench, 2);
		await receiveReturn(db, {
			orderId,
			lines: [{ lineId, quantity: 1 }],
			restock: false,
		});
		expect(await onHand(wrench)).toBe(0);
		const [row] = await db.select().from(schema.orderReturns);
		expect(row).toMatchObject({ quantity: 1, restocked: false, batchId: null });
	});

	test("a line can't take back more than it sold", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		const lineId = await shippedOrder(wrench, 2);
		await receiveReturn(db, {
			orderId,
			lines: [{ lineId, quantity: 1 }],
			restock: true,
		});
		await expect(
			receiveReturn(db, {
				orderId,
				lines: [{ lineId, quantity: 2 }],
				restock: true,
			}),
		).rejects.toThrow("Only 1 of WRENCH can still come back");
		// Nothing from the refused try stuck.
		expect(await onHand(wrench)).toBe(1);
	});

	test("each line counts only its own returns", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		// Two lines first, so line and return ids don't line up by chance.
		await shippedOrder(wrench, 2);
		const lineId = await shippedOrder(wrench, 2);
		await receiveReturn(db, {
			orderId,
			lines: [{ lineId, quantity: 1 }],
			restock: false,
		});
		await expect(
			receiveReturn(db, {
				orderId,
				lines: [{ lineId, quantity: 2 }],
				restock: false,
			}),
		).rejects.toThrow("Only 1 of WRENCH");
	});

	test("a returned tool set goes back as its parts", async () => {
		const handle = await createProduct(db, "HANDLE", "simple");
		const blade = await createProduct(db, "BLADE", "simple");
		const set = await createProduct(db, "SET", "bundle");
		await setRecipe(db, set, [
			{ productId: handle, quantity: 1 },
			{ productId: blade, quantity: 3 },
		]);
		const lineId = await shippedOrder(set, 1);
		await receiveReturn(db, {
			orderId,
			lines: [{ lineId, quantity: 1 }],
			restock: true,
		});
		expect(await onHand(handle)).toBe(1);
		expect(await onHand(blade)).toBe(3);
	});

	test("refuses orders whose stock never left or already came back", async () => {
		const wrench = await createProduct(db, "WRENCH", "simple");
		await postMovements(db, {
			lines: [
				{
					productId: wrench,
					locationId: warehouse,
					delta: 5,
					reason: "opening_balance",
				},
			],
		});
		const cases = [
			[{ cancelledAt: new Date() }, "was cancelled"],
			[{ fulfillmentStatus: "UNFULFILLED" }, "hasn't shipped"],
			[{ fulfilledByChannel: true }, "shipped by the marketplace"],
		] as const;
		for (const [extra, message] of cases) {
			const lineId = await shippedOrder(wrench, 1, extra);
			await expect(
				receiveReturn(db, {
					orderId,
					lines: [{ lineId, quantity: 1 }],
					restock: true,
				}),
			).rejects.toThrow(message);
		}
		expect(await onHand(wrench)).toBe(5);
	});

	test("an unmatched item can be written off but not restocked", async () => {
		const lineId = await shippedOrder(null, 1);
		await expect(
			receiveReturn(db, {
				orderId,
				lines: [{ lineId, quantity: 1 }],
				restock: true,
			}),
		).rejects.toThrow("Match WRENCH");
		await receiveReturn(db, {
			orderId,
			lines: [{ lineId, quantity: 1 }],
			restock: false,
		});
	});
});
