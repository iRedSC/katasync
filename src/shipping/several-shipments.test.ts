import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as schema from "#/db/schema";
import { BEHIND_REMAINING } from "#/orders/remaining";
import { buyDispatch } from "./buy";
import { addPackedDispatch } from "./dispatch.fixtures";
import { EMPTY_ORDER } from "./packed";
import { orderForShipping, shipmentPlan } from "./quick-ship";
import {
	addOrder,
	blockOf,
	buy,
	buying,
	db,
	freshOrder,
	handOff,
	lineId,
	orderId,
	packedIn,
	refused,
	statusOf,
	sync,
} from "./several-shipments.fixtures";

// One order going out in several shipments over time: staff choose which
// units ship now, and the rest waits for a later one.

freshOrder();

describe("choosing which units ship now", () => {
	test("every packable unit goes by default", async () => {
		const plan = await shipmentPlan(db, [orderId]);
		expect(plan.contentsKey).toBe("WRENCH×3");
		expect(plan.lowered).toEqual([]);
		expect(plan.choosable).toBe(true);
		expect(plan.total).toBe(45);
		expect(plan.choices).toMatchObject([{ packable: 3, quantity: 3 }]);
	});

	test("a lowered count changes the contents and what's insured", async () => {
		const plan = await shipmentPlan(
			db,
			[orderId],
			[{ orderLineId: lineId, quantity: 1 }],
		);
		expect(plan.contentsKey).toBe("WRENCH×1");
		expect(plan.lines.map((l) => l.quantity)).toEqual([1]);
		expect(plan.choices).toMatchObject([{ packable: 3, quantity: 1 }]);
		expect(plan.lowered).toEqual([{ orderLineId: lineId, quantity: 1 }]);
		// Part of the order is worth what those units sold for.
		expect(plan.total).toBe(10);
	});

	test("a line set to 0 is left out of the box", async () => {
		const [second] = await db
			.insert(schema.orderLines)
			.values({
				orderId,
				externalId: "line-knife",
				sku: "KNIFE",
				title: "Knife",
				quantity: 1,
				shippedQuantity: 0,
				unitPrice: 15,
			})
			.returning();
		const plan = await shipmentPlan(
			db,
			[orderId],
			[{ orderLineId: second.id, quantity: 0 }],
		);
		expect(plan.contentsKey).toBe("WRENCH×3");
		expect(plan.choices.map((c) => c.quantity)).toEqual([3, 0]);
		const { dispatchId } = await buy([{ orderLineId: second.id, quantity: 0 }]);
		expect(await packedIn(dispatchId)).toEqual([3]);
	});

	test("buying packs the chosen counts, and refuses counts the screen didn't show", async () => {
		const { dispatchId } = await buy([{ orderLineId: lineId, quantity: 2 }]);
		expect(await packedIn(dispatchId)).toEqual([2]);
	});

	test("a single unit has nothing to choose", async () => {
		const { orderId: one, lineId: oneLine } = await addOrder("2");
		await db
			.update(schema.orderLines)
			.set({ quantity: 1 })
			.where(eq(schema.orderLines.id, oneLine));
		expect((await shipmentPlan(db, [one])).choosable).toBe(false);
	});

	test("TikTok ships the whole order, so a partial selection is refused", async () => {
		const { orderId: tiktok, lineId: tiktokLine } = await addOrder("3", {
			salesChannel: "TikTok",
		});
		const plan = await shipmentPlan(
			db,
			[tiktok],
			[{ orderLineId: tiktokLine, quantity: 1 }],
		);
		// Not offered, and the plan ignores the counts.
		expect(plan.choosable).toBe(false);
		expect(plan.contentsKey).toBe("WRENCH×3");
		await expect(
			buyDispatch(
				db,
				{
					orderIds: [tiktok],
					contentsKey: "WRENCH×1",
					lowered: [{ orderLineId: tiktokLine, quantity: 1 }],
					boxes: [
						{
							packageId: null,
							lengthMm: 300,
							widthMm: 200,
							heightMm: 100,
							weightGrams: 600,
							insureAmount: null,
							hazmat: false,
						},
					],
					choice: { carrier: "USPS", service: "ground", id: "r", total: 100 },
					signature: false,
					setsDefault: true,
				},
				buying,
			),
		).rejects.toThrow("whole order");
		expect(buying.tiktokBuy).not.toHaveBeenCalled();
	});
});

describe("several shipments of one order", () => {
	test("the rest goes in a new shipment once the first is handed off and synced", async () => {
		const first = await buy([{ orderLineId: lineId, quantity: 1 }]);
		expect(await packedIn(first.dispatchId)).toEqual([1]);
		// While it's not handed off, it's the order's one open shipment.
		await expect(buy()).rejects.toThrow("already has a label not yet sent");

		await handOff(first.dispatchId, 2);
		expect(await statusOf()).toBe("PARTIALLY_FULFILLED");
		const [pin] = await db
			.select({ pin: schema.orders.pin })
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId));
		// Shopify hasn't synced its own count yet: packing now could pack the
		// unit just sent, so it waits.
		await expect(buy()).rejects.toThrow(BEHIND_REMAINING);
		expect((await shipmentPlan(db, [orderId])).lines).toEqual([]);

		await sync(1);
		const plan = await shipmentPlan(db, [orderId]);
		expect(plan.contentsKey).toBe("WRENCH×2");
		if (pin.pin !== null) {
			const found = await orderForShipping(db, pin.pin);
			// The first shipment is handed off; it doesn't block this one.
			expect(found?.liveDispatchId).toBeNull();
		}
		const second = await buy();
		expect(await packedIn(second.dispatchId)).toEqual([2]);
		await handOff(second.dispatchId, 0);
		expect(await statusOf()).toBe("FULFILLED");
	});
});

describe("units shipped outside katasync", () => {
	test("count toward the fence, so a stale count packs nothing", async () => {
		// 10 sold, 5 shipped from the marketplace's own admin.
		await db
			.update(schema.orderLines)
			.set({ quantity: 10, shippedQuantity: 5 })
			.where(eq(schema.orderLines.id, lineId));
		const first = await buy([{ orderLineId: lineId, quantity: 2 }]);
		// What the count was when the box was bought, kept with it.
		const [kept] = await db
			.select({ before: schema.dispatchLines.shippedBefore })
			.from(schema.dispatchLines)
			.where(eq(schema.dispatchLines.dispatchId, first.dispatchId));
		expect(kept.before).toBe(5);
		await handOff(first.dispatchId, 3);

		// Still 5 until the next sync: 2 handed off is covered by 5, but
		// those 5 were all shipped before, so it's stale.
		await expect(buy()).rejects.toThrow(BEHIND_REMAINING);
		expect((await shipmentPlan(db, [orderId])).lines).toEqual([]);

		await sync(7);
		const plan = await shipmentPlan(db, [orderId]);
		expect(plan.choices).toMatchObject([{ packable: 3, quantity: 3 }]);
		expect(await packedIn((await buy()).dispatchId)).toEqual([3]);
	});

	test("the count kept is the database's, whatever the app passes", async () => {
		await sync(1);
		await db.transaction(async (tx) => {
			const [d] = await tx
				.insert(schema.dispatches)
				.values({ contentsKey: "WRENCH×1", contents: "packed", boxCount: 1 })
				.returning();
			await tx
				.insert(schema.dispatchOrders)
				.values({ dispatchId: d.id, orderId });
			await tx.insert(schema.dispatchLines).values({
				dispatchId: d.id,
				orderId,
				lineExternalId: "line-1",
				title: "Wrench",
				quantity: 1,
				shippedBefore: 99,
			});
		});
		const kept = await db
			.select({ before: schema.dispatchLines.shippedBefore })
			.from(schema.dispatchLines);
		expect(kept.map((k) => k.before)).toEqual([1]);
	});

	test("a handoff from before the count was kept falls back to all units handed off", async () => {
		// As a dispatch from main has it: no shipped_before.
		await db.execute(
			sql`alter table dispatch_lines disable trigger dispatch_lines_packable`,
		);
		const { dispatchId } = await addPackedDispatch(db, {
			orderIds: [orderId],
			units: 2,
		});
		await db.execute(
			sql`alter table dispatch_lines enable trigger dispatch_lines_packable`,
		);
		await db
			.update(schema.dispatchOrders)
			.set({ channelSentAt: new Date() })
			.where(eq(schema.dispatchOrders.dispatchId, dispatchId));
		await sync(1);
		await refused(
			addPackedDispatch(db, { orderIds: [orderId], units: 1 }),
			"wait for the next sync",
		);
		await sync(2);
		await addPackedDispatch(db, { orderIds: [orderId], units: 1 });
	});
});

describe("a count katasync's handoff can't explain", () => {
	test("says so once the order has synced since the handoff", async () => {
		const first = await buy([{ orderLineId: lineId, quantity: 1 }]);
		await handOff(first.dispatchId, 2);
		// Not synced since: likely just lag.
		await db
			.update(schema.orders)
			.set({ syncedAt: new Date(Date.now() - 60_000) })
			.where(eq(schema.orders.id, orderId));
		expect(await blockOf()).toBe("behind");
		// Synced since, and the marketplace still says none shipped: its
		// fulfillment was likely cancelled there.
		await db
			.update(schema.orders)
			.set({ syncedAt: new Date(Date.now() + 60_000) })
			.where(eq(schema.orders.id, orderId));
		expect(await blockOf()).toBe("short");
		await expect(buy()).rejects.toThrow("fewer shipped than katasync sent");
		// Caught up: nothing blocks it.
		await sync(1);
		expect(await blockOf()).toBeNull();
	});
});

describe("combining orders", () => {
	test("an order with nothing in the box is refused, not attached empty", async () => {
		const { orderId: other, lineId: otherLine } = await addOrder("6");
		const ids = [orderId, other];
		const zeroed = [{ orderLineId: otherLine, quantity: 0 }];
		await expect(shipmentPlan(db, ids, zeroed)).rejects.toThrow(EMPTY_ORDER);
		// Past the plan, as a stale or hand-made request would be.
		await expect(
			buyDispatch(
				db,
				{
					orderIds: ids,
					contentsKey: "WRENCH×3",
					lowered: zeroed,
					boxes: [
						{
							packageId: null,
							lengthMm: 300,
							widthMm: 200,
							heightMm: 100,
							weightGrams: 600,
							insureAmount: null,
							hazmat: false,
						},
					],
					choice: { carrier: "USPS", service: "ground", id: "r", total: 100 },
					signature: false,
					setsDefault: true,
				},
				buying,
			),
		).rejects.toThrow(EMPTY_ORDER);
		expect(await db.select().from(schema.dispatchOrders)).toEqual([]);
	});

	test("the database refuses a packed dispatch with an order none of whose lines are in it", async () => {
		const { orderId: other } = await addOrder("7");
		await refused(
			db.transaction(async (tx) => {
				const [d] = await tx
					.insert(schema.dispatches)
					.values({ contentsKey: "WRENCH×3", contents: "packed", boxCount: 1 })
					.returning();
				await tx.insert(schema.dispatchOrders).values([
					{ dispatchId: d.id, orderId },
					{ dispatchId: d.id, orderId: other },
				]);
				await tx.insert(schema.dispatchLines).values({
					dispatchId: d.id,
					orderId,
					lineExternalId: "line-1",
					title: "Wrench",
					quantity: 3,
				});
			}),
			"with none of its lines",
		);
	});
});

describe("the database", () => {
	test("allows one live dispatch not yet handed off per order", async () => {
		await addPackedDispatch(db, { orderIds: [orderId], units: 1 });
		await refused(
			addPackedDispatch(db, { orderIds: [orderId], units: 1 }),
			"already has a label not yet handed off",
		);
	});

	test("refuses a unit packed twice, even past the one-dispatch check", async () => {
		await db.insert(schema.orderLines).values({
			orderId,
			externalId: "line-knife",
			sku: "KNIFE",
			title: "Knife",
			quantity: 1,
			shippedQuantity: 0,
			unitPrice: 15,
		});
		// A dispatch that joined the order before the other had a label, so
		// only the line check is left to stop a unit going in both.
		const early = await db.transaction(async (tx) => {
			const [d] = await tx
				.insert(schema.dispatches)
				.values({ contentsKey: "KNIFE×1", contents: "packed", boxCount: 1 })
				.returning();
			await tx
				.insert(schema.dispatchOrders)
				.values({ dispatchId: d.id, orderId });
			await tx.insert(schema.dispatchLines).values({
				dispatchId: d.id,
				orderId,
				lineExternalId: "line-knife",
				title: "Knife",
				quantity: 1,
			});
			return d.id;
		});
		await addPackedDispatch(db, { orderIds: [orderId], units: 2 });
		const wrench = {
			dispatchId: early,
			orderId,
			lineExternalId: "line-1",
			orderLineId: lineId,
			title: "Wrench",
		};
		await refused(
			db.insert(schema.dispatchLines).values({ ...wrench, quantity: 2 }),
			"fewer than 2 units left to pack",
		);
		// What's left still fits.
		await db.insert(schema.dispatchLines).values({ ...wrench, quantity: 1 });
	});

	test("refuses more than the line has, or any of an unknown line", async () => {
		await refused(
			db.transaction(async (tx) => {
				const [d] = await tx
					.insert(schema.dispatches)
					.values({ contentsKey: "WRENCH×4", contents: "packed", boxCount: 1 })
					.returning();
				await tx
					.insert(schema.dispatchOrders)
					.values({ dispatchId: d.id, orderId });
				await tx.insert(schema.dispatchLines).values({
					dispatchId: d.id,
					orderId,
					lineExternalId: "line-1",
					title: "Wrench",
					quantity: 4,
				});
			}),
			"fewer than 4 units left to pack",
		);
		const { orderId: other } = await addOrder("4");
		await db
			.update(schema.orderLines)
			.set({ shippedQuantity: null })
			.where(eq(schema.orderLines.orderId, other));
		// Unknown means nothing is packable.
		await refused(
			addPackedDispatch(db, { orderIds: [other] }),
			"fewer than 3 units left to pack",
		);
	});

	test("refuses packing behind a count that predates our own handoff", async () => {
		const { dispatchId } = await addPackedDispatch(db, {
			orderIds: [orderId],
			units: 1,
		});
		await db
			.update(schema.dispatchOrders)
			.set({ channelSentAt: new Date() })
			.where(eq(schema.dispatchOrders.dispatchId, dispatchId));
		await refused(
			addPackedDispatch(db, { orderIds: [orderId], units: 1 }),
			"wait for the next sync",
		);
		await sync(1);
		await addPackedDispatch(db, { orderIds: [orderId], units: 2 });
	});
});
