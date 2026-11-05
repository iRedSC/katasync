import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { syncedOpen } from "#/test/open-reads";
import { WHOLE_LINE } from "./packed";
import { shipmentPlan } from "./quick-ship";

// eBay takes one tracking number per line item, so quick ship plans each
// eBay line whole or not at all (choose in packed.ts).

let db: Db;
let order: number;

const addLine = async (sku: string, quantity: number) =>
	(
		await db
			.insert(schema.orderLines)
			.values({
				orderId: order,
				externalId: `#1-${sku}`,
				sku,
				title: sku,
				quantity,
				shippedQuantity: 0,
				unitPrice: 20,
			})
			.returning()
	)[0].id;

beforeEach(async () => {
	db = await createTestDb();
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "ebay", name: "eBay" })
		.returning();
	[{ id: order }] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "#1",
			name: "#1",
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 80,
			sourceUpdatedAt: new Date(),
			shipAddress1: "12 Oak St",
			shipCity: "Erie",
			shipPostalCode: "16501",
			shipCountry: "US",
		})
		.returning();
});

const plan = (lowered: { orderLineId: number; quantity: number }[] = []) =>
	shipmentPlan(db, [order], lowered, syncedOpen(db));

test("an eBay order's lines go whole or not at all", async () => {
	const wrench = await addLine("WRENCH", 3);
	await addLine("KNIFE", 1);
	const all = await plan();
	expect(all.choices.map((c) => c.whole)).toEqual([true, true]);
	// Two lines, each all or none: there's a choice.
	expect(all.choosable).toBe(true);
	await expect(plan([{ orderLineId: wrench, quantity: 2 }])).rejects.toThrow(
		WHOLE_LINE,
	);
	const later = await plan([{ orderLineId: wrench, quantity: 0 }]);
	expect(later.choices.map((c) => c.quantity)).toEqual([0, 1]);
	expect(later.lowered).toEqual([{ orderLineId: wrench, quantity: 0 }]);
});

test("one eBay line, however many units, has nothing to choose", async () => {
	await addLine("WRENCH", 3);
	expect((await plan()).choosable).toBe(false);
});
