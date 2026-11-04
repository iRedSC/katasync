import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import * as schema from "#/db/schema";
import { buyDispatch } from "./buy";
import { addPackedDispatch } from "./dispatch.fixtures";
import { voidDispatch } from "./handoff";
import { EMPTY_ORDER } from "./packed";
import { orderForShipping } from "./quick-ship";
import {
	addOrder,
	buy,
	buying,
	db,
	freshOrder,
	handOff,
	lineId,
	marketplace,
	openReads,
	orderId,
	packedIn,
	planOf,
	refused,
	shipOutside,
	shopify,
	statusOf,
	sync,
} from "./several-shipments.fixtures";

// One order going out in several shipments over time: staff choose which
// units ship now, and the rest waits for a later one.

freshOrder();

describe("choosing which units ship now", () => {
	test("every packable unit goes by default", async () => {
		const plan = await planOf();
		expect(plan.contentsKey).toBe("WRENCH×3");
		expect(plan.lowered).toEqual([]);
		expect(plan.choosable).toBe(true);
		expect(plan.total).toBe(45);
		expect(plan.choices).toMatchObject([{ packable: 3, quantity: 3 }]);
	});

	test("a lowered count changes the contents and what's insured", async () => {
		const plan = await planOf(
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
		marketplace.open.set("line-knife", 1);
		const plan = await planOf(
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
		marketplace.open.set("line-2", 1);
		expect((await planOf([one])).choosable).toBe(false);
	});

	test("TikTok ships the whole order, so a partial selection is refused", async () => {
		const { orderId: tiktok, lineId: tiktokLine } = await addOrder("3", {
			salesChannel: "TikTok",
		});
		const before = marketplace.reads;
		const plan = await planOf(
			[tiktok],
			[{ orderLineId: tiktokLine, quantity: 1 }],
		);
		// TikTok's own units are checked when its label is bought, not read
		// here.
		expect(marketplace.reads).toBe(before);
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
	test("the rest goes in a new shipment once the first is handed off, with no sync", async () => {
		const printed = async () =>
			(
				await db
					.select({ at: schema.orders.invoicePrintedAt })
					.from(schema.orders)
					.where(eq(schema.orders.id, orderId))
			)[0].at;
		await db
			.update(schema.orders)
			.set({ invoicePrintedAt: new Date() })
			.where(eq(schema.orders.id, orderId));
		const first = await buy([{ orderLineId: lineId, quantity: 1 }]);
		expect(await packedIn(first.dispatchId)).toEqual([1]);
		// While it's not handed off, it's the order's one open shipment.
		await expect(buy()).rejects.toThrow("already has a label not yet sent");

		await handOff(first.dispatchId);
		expect(await statusOf()).toBe("PARTIALLY_FULFILLED");
		// What's left is new picking work, so Print all takes it again.
		expect(await printed()).toBeNull();
		// The synced count still says none shipped; Shopify says 2 are open.
		const plan = await planOf();
		expect(plan.choices).toMatchObject([{ packable: 2, quantity: 2 }]);
		const [{ pin }] = await db
			.select({ pin: schema.orders.pin })
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId));
		if (pin !== null) {
			const found = await orderForShipping(db, pin, openReads);
			// The first shipment is handed off; it doesn't block this one.
			expect(found?.liveDispatchId).toBeNull();
		}
		const second = await buy();
		expect(await packedIn(second.dispatchId)).toEqual([2]);
		await handOff(second.dispatchId);
		expect(await statusOf()).toBe("FULFILLED");
	});
});

describe("what's packable is what the marketplace says is open, live", () => {
	test("the plan reads it once, and the purchase again", async () => {
		const before = marketplace.reads;
		const plan = await planOf();
		expect(marketplace.reads).toBe(before + 1);
		await buy(plan.lowered);
		// buy() plans once more as the browser would, then the purchase reads.
		expect(marketplace.reads).toBe(before + 3);
	});

	test("eBay is read the same way", async () => {
		const [ebay] = await db
			.insert(schema.stores)
			.values({ channel: "ebay", name: "eBay" })
			.returning();
		const { orderId: sale } = await addOrder("8", { storeId: ebay.id });
		marketplace.open.set("line-8", 2);
		await sync(3);
		const plan = await planOf([sale]);
		expect(plan.choices).toMatchObject([{ packable: 2, quantity: 2 }]);
		expect(await packedIn((await buy([], [sale])).dispatchId)).toEqual([2]);
	});

	test("a marketplace that doesn't answer stops the plan and the purchase, nothing bought", async () => {
		marketplace.failing = true;
		const plan = await planOf();
		expect(plan.unread).toBe(
			"1: Shopify didn't say what's left to ship. Try again",
		);
		expect(plan.lines).toEqual([]);
		await expect(
			buyDispatch(
				db,
				{
					orderIds: [orderId],
					contentsKey: "WRENCH×3",
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
		).rejects.toThrow("Shopify didn't say what's left to ship");
		expect(await db.select().from(schema.dispatches)).toEqual([]);
	});

	test("more than is open is refused by the purchase, whatever the screen sent", async () => {
		// Synced says 3 to ship; Shopify has shipped 1 from its admin since.
		shipOutside(1);
		const asShown = (lowered: { orderLineId: number; quantity: number }[]) =>
			buyDispatch(
				db,
				{
					orderIds: [orderId],
					contentsKey: "WRENCH×3",
					lowered,
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
			);
		await expect(asShown([])).rejects.toThrow("The order changed");
		await expect(
			asShown([{ orderLineId: lineId, quantity: 3 }]),
		).rejects.toThrow("Only 2 of a line can be packed");
		expect(await db.select().from(schema.dispatches)).toEqual([]);
	});
});

// Sequences that broke the fence of synced counts this replaced: each one
// once packed a unit twice, or never let the order pack again.
describe("a stale synced count can't pack a unit twice", () => {
	test("shipped outside between purchase and handoff, then an older handoff voided", async () => {
		await db
			.update(schema.orderLines)
			.set({ quantity: 10 })
			.where(eq(schema.orderLines.id, lineId));
		marketplace.open.set("line-1", 10);
		const d1 = await buy([{ orderLineId: lineId, quantity: 2 }]);
		await handOff(d1.dispatchId);
		await sync(2);
		const d2 = await buy([{ orderLineId: lineId, quantity: 3 }]);
		// 4 go out from Shopify's admin before D2 is handed off.
		shipOutside(4);
		await handOff(d2.dispatchId);
		await voidDispatch(db, d1.dispatchId, shopify());
		// Shopify: 10 less 3 (D2) less 4 (outside), D1's 2 back: 3 open.
		// The synced count still says 2.
		const plan = await planOf();
		expect(plan.choices).toMatchObject([{ packable: 3, quantity: 3 }]);
		const d3 = await buy();
		expect(await packedIn(d3.dispatchId)).toEqual([3]);
		await handOff(d3.dispatchId);
		expect(marketplace.open.get("line-1")).toBe(0);
	});

	test("an earlier handoff with no kept counts, after a shipment outside", async () => {
		// As a dispatch from before this change: 2 handed off, and 1 shipped
		// from Shopify's admin. The sync last saw only the 1.
		const { dispatchId } = await addPackedDispatch(db, {
			orderIds: [orderId],
			units: 2,
		});
		await db
			.update(schema.dispatchOrders)
			.set({ channelSentAt: new Date() })
			.where(eq(schema.dispatchOrders.dispatchId, dispatchId));
		shipOutside(1);
		// What the handoff of 2 took off Shopify's open count.
		shipOutside(2);
		await sync(1);
		const plan = await planOf();
		expect(plan.choices).toEqual([]);
		await expect(buy()).rejects.toThrow("Nothing on these orders to pack");
		expect(await db.select().from(schema.dispatches)).toHaveLength(1);
	});

	test("voided and bought again before the cancellation syncs", async () => {
		const first = await buy();
		await handOff(first.dispatchId);
		await sync(3);
		await voidDispatch(db, first.dispatchId, shopify());
		// Shopify has all 3 open again; the sync still says 3 shipped.
		const plan = await planOf();
		expect(plan.choices).toMatchObject([{ packable: 3, quantity: 3 }]);
		expect(await packedIn((await buy()).dispatchId)).toEqual([3]);
	});
});

describe("combining orders", () => {
	test("an order with nothing in the box is refused, not attached empty", async () => {
		const { orderId: other, lineId: otherLine } = await addOrder("6");
		const ids = [orderId, other];
		const zeroed = [{ orderLineId: otherLine, quantity: 0 }];
		marketplace.open.set("line-6", 3);
		await expect(planOf(ids, zeroed)).rejects.toThrow(EMPTY_ORDER);
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

	test("refuses more of a line than was sold", async () => {
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
		// The synced count doesn't bound it: the live read does.
		await sync(3);
		await addPackedDispatch(db, { orderIds: [orderId], units: 3 });
	});
});
