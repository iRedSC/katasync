import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { BEHIND_REMAINING } from "#/orders/remaining";
import { createTestDb } from "#/test/db";
import { type BuyOutside, buyDispatch } from "./buy";
import { memoryLocker } from "./dispatch";
import { addPackedDispatch } from "./dispatch.fixtures";
import { type Outside, sendTracking } from "./handoff";
import type { Lowered } from "./packed";
import { orderForShipping, shipmentPlan } from "./quick-ship";

// One order going out in several shipments over time: staff choose which
// units ship now, and the rest waits for a later one.

let db: Db;
let storeId: number;
let orderId: number;
let lineId: number;
let n = 0;

async function addOrder(name: string, extra: Record<string, unknown> = {}) {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId: `gid://shopify/Order/${name}`,
			name,
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 45,
			sourceUpdatedAt: new Date(),
			shipAddress1: "12 Oak St",
			shipCity: "Erie",
			shipPostalCode: "16501",
			shipCountry: "US",
			...extra,
		})
		.returning();
	const [line] = await db
		.insert(schema.orderLines)
		.values({
			orderId: row.id,
			externalId: `line-${name}`,
			sku: "WRENCH",
			title: "Wrench",
			quantity: 3,
			shippedQuantity: 0,
			unitPrice: 10,
		})
		.returning();
	return { orderId: row.id, lineId: line.id };
}

const buying: BuyOutside = {
	lock: memoryLocker(),
	getRates: vi.fn(async () => ({
		rates: [
			{
				id: `g${++n}`,
				carrier: "USPS",
				service: "ground",
				serviceName: "USPS Ground Advantage",
				cost: 7,
				days: 3,
			},
		],
		notes: [],
	})),
	getRate: vi.fn(async (id: string) => ({
		id,
		carrier: "USPS",
		carrierToken: "usps",
		service: "ground",
		serviceName: "USPS Ground Advantage",
		cost: 7,
		days: 3,
	})),
	buyLabel: vi.fn(async (rateId: string) => ({
		id: `tx${++n}`,
		labelUrl: "https://example.com/l.pdf",
		trackingNumber: `9400${n}-${rateId}`,
		trackingUrl: null,
	})),
	refund: vi.fn(async () => ({ status: "QUEUED" })),
	tiktokBuy: vi.fn(),
	tiktokUnits: vi.fn(),
	ebayCheck: vi.fn(async () => {}),
	isTest: () => false,
};

// Buys what quick ship's plan shows for these counts, as the browser would.
async function buy(lowered: Lowered = [], ids = [orderId]) {
	const plan = await shipmentPlan(db, ids, lowered);
	return buyDispatch(
		db,
		{
			orderIds: ids,
			contentsKey: plan.contentsKey,
			lowered: plan.lowered,
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
}

// Hands a dispatch off to Shopify, which says how much is left after it.
function handOff(dispatchId: number, remaining: number) {
	const outside: Outside = {
		lock: memoryLocker(),
		shopifyFulfill: vi.fn(async () => ({
			fulfillmentId: `f-${dispatchId}`,
			remaining,
		})),
		shopifyCancel: vi.fn(async () => {}),
		shopifySaveTracking: vi.fn(async () => {}),
		shopifyRemoveTracking: vi.fn(async () => {}),
		ebayShip: vi.fn(),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokShip: vi.fn(),
		tiktokUnits: vi.fn(),
	};
	return sendTracking(db, dispatchId, outside);
}

// The marketplace's own count, as the next sync writes it.
const sync = (shippedQuantity: number) =>
	db
		.update(schema.orderLines)
		.set({ shippedQuantity })
		.where(eq(schema.orderLines.id, lineId));

const packedIn = async (dispatchId: number) =>
	(
		await db
			.select({ quantity: schema.dispatchLines.quantity })
			.from(schema.dispatchLines)
			.where(eq(schema.dispatchLines.dispatchId, dispatchId))
	).map((l) => l.quantity);

const statusOf = async () =>
	(
		await db
			.select({ status: schema.orders.fulfillmentStatus })
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId))
	)[0].status;

beforeEach(async () => {
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	await db.insert(schema.locations).values({
		name: "Warehouse",
		kind: "owned",
		address1: "1 Mill Rd",
		city: "Erie",
		postalCode: "16502",
		country: "US",
		email: "ship@example.com",
	});
	({ orderId, lineId } = await addOrder("1"));
});

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

// The database's own reason, under Drizzle's "Failed query" wrapper.
async function refused(work: Promise<unknown>, why: string) {
	const err = await work.then(
		() => null,
		(e: unknown) => e as Error & { cause?: Error },
	);
	expect(err?.cause?.message ?? err?.message).toContain(why);
}

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
