import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { type BoxPlan, type BuyOutside, buyDispatch } from "./buy";
import { memoryLocker } from "./dispatch";

let db: Db;
let storeId: number;

const address = {
	shipAddress1: "12 Oak St",
	shipCity: "Erie",
	shipPostalCode: "16501",
	shipCountry: "US",
};

async function addOrder(name: string, extra: Record<string, unknown> = {}) {
	const [row] = await db
		.insert(schema.orders)
		.values({
			storeId,
			externalId: name,
			name,
			placedAt: new Date(),
			fulfillmentStatus: "UNFULFILLED",
			total: 30,
			sourceUpdatedAt: new Date(),
			...address,
			...extra,
		})
		.returning();
	return row.id;
}

// Shippo ids are unique, across every fake.
let n = 0;

function fakes(overrides: Partial<BuyOutside> = {}): BuyOutside {
	return {
		lock: memoryLocker(),
		// Each call is a fresh quote with fresh rate ids, as Shippo's are.
		getRates: vi.fn(async () => {
			n++;
			return {
				rates: [
					{
						id: `g${n}`,
						carrier: "USPS",
						service: "ground",
						serviceName: "USPS Ground Advantage",
						cost: 7,
						days: 3,
					},
					{
						id: `p${n}`,
						carrier: "USPS",
						service: "priority",
						serviceName: "USPS Priority",
						cost: 10,
						days: 2,
					},
				],
				notes: [],
			};
		}),
		buyLabel: vi.fn(async (rateId: string) => {
			n++;
			return {
				id: `tx${n}`,
				labelUrl: "https://example.com/l.pdf",
				trackingNumber: `9400${n}-${rateId}`,
				trackingUrl: null,
			};
		}),
		getRate: vi.fn(async (rateId: string) => ({
			id: rateId,
			carrier: "USPS",
			carrierToken: "usps",
			service: "ground",
			serviceName: "USPS Ground Advantage",
			cost: 7,
			days: 3,
		})),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokBuy: vi.fn(),
		isTest: () => false,
		...overrides,
	};
}

const box = (extra: Partial<BoxPlan> = {}): BoxPlan => ({
	packageId: null,
	lengthMm: 300,
	widthMm: 200,
	heightMm: 100,
	weightGrams: 600,
	insureAmount: null,
	...extra,
});
const ground = { carrier: "USPS", service: "ground", id: "browser-rate" };
const buy = (orderIds: number[], boxes: BoxPlan[], outside = fakes()) =>
	buyDispatch(
		db,
		{ orderIds, contentsKey: "X", boxes, choice: ground },
		outside,
	);

const dispatchOf = async (id: number) =>
	(
		await db
			.select()
			.from(schema.dispatches)
			.where(eq(schema.dispatches.id, id))
	)[0];
const boxesOf = (dispatchId: number) =>
	db
		.select()
		.from(schema.shipments)
		.where(eq(schema.shipments.dispatchId, dispatchId))
		.orderBy(schema.shipments.id);

beforeEach(async () => {
	n = 0;
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	// The ship-from address labels need.
	await db.insert(schema.locations).values({
		name: "Warehouse",
		kind: "owned",
		address1: "1 Mill Rd",
		city: "Erie",
		postalCode: "16502",
		country: "US",
		email: "ship@example.com",
	});
});

describe("buyDispatch", () => {
	test("prices each box itself and buys the chosen service for every order", async () => {
		const a = await addOrder("#1");
		const b = await addOrder("#2");
		const outside = fakes();
		const bought = await buy(
			[a, b],
			[box(), box({ weightGrams: 900 })],
			outside,
		);

		expect(bought.failed).toBeNull();
		// Quoted from the order's own address and each box's own weight, not
		// from anything the browser said about rates.
		expect(outside.getRates).toHaveBeenCalledWith(
			expect.objectContaining({
				to: expect.objectContaining({ zip: "16501" }),
				parcel: expect.objectContaining({ weightGrams: 900 }),
			}),
		);
		expect(outside.buyLabel).not.toHaveBeenCalledWith("browser-rate");
		const saved = await boxesOf(bought.dispatchId);
		expect(saved.map((x) => x.service)).toEqual(["ground", "ground"]);
		expect(saved.map((box) => box.carrierToken)).toEqual(["usps", "usps"]);
		expect((await dispatchOf(bought.dispatchId)).boughtAt).not.toBeNull();
		const members = await db
			.select()
			.from(schema.dispatchOrders)
			.where(eq(schema.dispatchOrders.dispatchId, bought.dispatchId));
		expect(members.map((d) => d.orderId).sort()).toEqual([a, b].sort());
	});

	test("refuses a second shipment while one is live", async () => {
		const a = await addOrder("#1");
		await buy([a], [box()]);
		const outside = fakes();
		await expect(buy([a], [box()], outside)).rejects.toThrow(
			"already has a label",
		);
		expect(outside.buyLabel).not.toHaveBeenCalled();
	});

	test("two presses at once buy once", async () => {
		const a = await addOrder("#1");
		const outside = fakes();
		const results = await Promise.allSettled([
			buy([a], [box()], outside),
			buy([a], [box()], outside),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(outside.buyLabel).toHaveBeenCalledTimes(1);
	});

	test("won't combine orders to different addresses", async () => {
		const a = await addOrder("#1");
		const b = await addOrder("#2", { shipPostalCode: "90210" });
		const outside = fakes();
		await expect(buy([a, b], [box()], outside)).rejects.toThrow("same address");
		expect(outside.buyLabel).not.toHaveBeenCalled();
	});

	test("a service no longer offered stops before anything is bought", async () => {
		const a = await addOrder("#1");
		const outside = fakes();
		await expect(
			buyDispatch(
				db,
				{
					orderIds: [a],
					contentsKey: "X",
					boxes: [box()],
					choice: { carrier: "UPS", service: "ground", id: "x" },
				},
				outside,
			),
		).rejects.toThrow("price again");
		expect(outside.buyLabel).not.toHaveBeenCalled();
	});

	test("a mismatched confirmed rate stops before any label is bought", async () => {
		const orderId = await addOrder("#1");
		const outside = fakes({
			getRate: vi.fn(async (rateId: string) => ({
				id: rateId,
				carrier: "USPS",
				carrierToken: "usps",
				service: "priority",
				serviceName: "Priority",
				cost: 10,
				days: 2,
			})),
		});
		await expect(buy([orderId], [box()], outside)).rejects.toThrow(
			"quoted service changed",
		);
		expect(outside.buyLabel).not.toHaveBeenCalled();
	});

	test("a box deleted from Settings stops before anything is bought", async () => {
		const a = await addOrder("#1");
		const outside = fakes();
		await expect(
			buy([a], [box(), box({ packageId: 999 })], outside),
		).rejects.toThrow("deleted");
		expect(outside.buyLabel).not.toHaveBeenCalled();
	});

	test("a cancelled order can't be bought for", async () => {
		const a = await addOrder("#1", { cancelledAt: new Date() });
		await expect(buy([a], [box()])).rejects.toThrow("no longer needs shipping");
	});

	test("a box failing part way refunds the ones bought and never counts as bought", async () => {
		const a = await addOrder("#1");
		let calls = 0;
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				n++;
				calls++;
				if (calls === 2) throw new Error("carrier down");
				return {
					id: `tx${n}`,
					labelUrl: "u",
					trackingNumber: `9400${n}`,
					trackingUrl: null,
				};
			}),
		});
		const bought = await buy([a], [box(), box()], outside);
		expect(bought.failed).toContain("Box 2 of 2 wasn't bought (carrier down)");
		expect(bought.failed).toContain("refunded");
		const saved = await boxesOf(bought.dispatchId);
		expect(saved).toHaveLength(1);
		expect(outside.refund).toHaveBeenCalledWith(saved[0].externalId);
		expect(saved[0].voidedAt).not.toBeNull();
		expect((await dispatchOf(bought.dispatchId)).boughtAt).toBeNull();

		// Nothing live, so pressing again works.
		expect((await buy([a], [box(), box()])).failed).toBeNull();
	});

	test("a refund refused after a part-way failure keeps that label live and incomplete", async () => {
		const a = await addOrder("#1");
		let calls = 0;
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				n++;
				calls++;
				if (calls === 2) throw new Error("carrier down");
				return {
					id: `tx${n}`,
					labelUrl: "u",
					trackingNumber: "T",
					trackingUrl: null,
				};
			}),
			refund: vi.fn(async () => {
				throw new Error("already scanned");
			}),
		});
		const bought = await buy([a], [box(), box()], outside);
		expect(bought.failed).toContain("couldn't be refunded");
		expect((await boxesOf(bought.dispatchId))[0].voidedAt).toBeNull();
		expect((await dispatchOf(bought.dispatchId)).boughtAt).toBeNull();
	});

	test("the first box failing buys nothing", async () => {
		const a = await addOrder("#1");
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				throw new Error("bad address");
			}),
		});
		await expect(buy([a], [box()], outside)).rejects.toThrow("bad address");
		expect(await db.select().from(schema.shipments)).toEqual([]);
		// The order is free to try again.
		expect((await buy([a], [box()])).failed).toBeNull();
	});

	test("a later label failing to save refunds every bought box", async () => {
		const orderId = await addOrder("#1");
		await db.execute(
			sql`create function fail_second_box() returns trigger language plpgsql as $$ begin if new.weight_grams = 900 then raise exception 'save failed'; end if; return new; end $$`,
		);
		await db.execute(
			sql`create trigger fail_second_box before insert on shipments for each row execute function fail_second_box()`,
		);
		const outside = fakes();
		const result = await buy(
			[orderId],
			[box(), box({ weightGrams: 900 })],
			outside,
		);
		expect(result.failed).toContain("couldn't be saved");
		expect(outside.refund).toHaveBeenCalledTimes(2);
		expect(result.boxes).toHaveLength(1);
		expect(result.boxes[0].voidedAt).not.toBeNull();
		const [handoff] = await db
			.select()
			.from(schema.dispatchOrders)
			.where(eq(schema.dispatchOrders.dispatchId, result.dispatchId));
		expect(handoff.reversedAt).not.toBeNull();
	});

	test("TikTok orders stay one order, one box", async () => {
		const a = await addOrder("#1", { salesChannel: "TikTok" });
		const outside = fakes();
		await expect(buy([a], [box(), box()], outside)).rejects.toThrow(
			"Seller Center",
		);
		expect(outside.tiktokBuy).not.toHaveBeenCalled();
	});
});
