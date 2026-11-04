import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as schema from "#/db/schema";
import { BEHIND_REMAINING } from "#/orders/remaining";
import { voidDispatch } from "./handoff";
import { shipmentPlan } from "./quick-ship";
import {
	blockOf,
	buy,
	db,
	freshOrder,
	handOff,
	lineId,
	orderId,
	shopify,
	sync,
} from "./several-shipments.fixtures";

// An order shipped in several handoffs, one of which is voided: the fence
// (drizzle/0182's order_line_shipped_needed) comes down by the units the
// void took back only when the newer handoff's count had included them.

freshOrder();

describe("an earlier handoff voided", () => {
	// 10 sold; D1 takes 2 and goes out, then D2 takes 3.
	async function twoHandoffs() {
		await db
			.update(schema.orderLines)
			.set({ quantity: 10 })
			.where(eq(schema.orderLines.id, lineId));
		const d1 = await buy([{ orderLineId: lineId, quantity: 2 }]);
		await handOff(d1.dispatchId, 8);
		await sync(2);
		const d2 = await buy([{ orderLineId: lineId, quantity: 3 }]);
		await handOff(d2.dispatchId, 5);
		return { d1: d1.dispatchId, d2: d2.dispatchId };
	}
	const packable = async () =>
		(await shipmentPlan(db, [orderId])).choices.map((c) => c.packable);

	test("after the newer one went out lowers the fence by its units", async () => {
		const { d1 } = await twoHandoffs();
		await voidDispatch(db, d1, shopify());
		// Still the count from before D2: it never saw D2, so it's refused.
		await expect(buy()).rejects.toThrow(BEHIND_REMAINING);
		// Shopify now has D2's 3 and not D1's 2.
		await sync(3);
		expect(await blockOf()).toBeNull();
		expect(await packable()).toEqual([7]);
	});

	test("clears on a count that keeps the voided units, which stay unpackable", async () => {
		const { d1 } = await twoHandoffs();
		await voidDispatch(db, d1, shopify());
		// As eBay does: the old tracking stays, so 2 + 3.
		await sync(5);
		expect(await blockOf()).toBeNull();
		expect(await packable()).toEqual([5]);
	});

	test("before the newer one was bought isn't taken off again", async () => {
		await db
			.update(schema.orderLines)
			.set({ quantity: 10 })
			.where(eq(schema.orderLines.id, lineId));
		const d1 = await buy([{ orderLineId: lineId, quantity: 3 }]);
		await handOff(d1.dispatchId, 7);
		await sync(3);
		await voidDispatch(db, d1.dispatchId, shopify());
		await sync(0);
		const d2 = await buy([{ orderLineId: lineId, quantity: 2 }]);
		await handOff(d2.dispatchId, 8);
		// The count D2 was bought at already left D1 out, so a snapshot of 0
		// would pack D2's 2 again.
		await expect(buy()).rejects.toThrow(BEHIND_REMAINING);
		await sync(2);
		expect(await packable()).toEqual([8]);
	});
});
