import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { type BoxPlan, type BuyOutside, buyDispatch } from "./buy";

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
		getRate: vi.fn(async (id: string) => ({
			id,
			carrier: "USPS",
			service: id.startsWith("p") ? "priority" : "ground",
			serviceName: "USPS Ground Advantage",
			cost: 7,
			days: 3,
		})),
		buyLabel: vi.fn(async () => {
			n++;
			return {
				id: `tx${n}`,
				labelUrl: "https://example.com/l.pdf",
				trackingNumber: `9400${n}`,
				trackingUrl: null,
			};
		}),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokBuy: vi.fn(),
		isTest: () => false,
		...overrides,
	};
}

const box = (rateId = "g1"): BoxPlan => ({
	packageId: null,
	lengthMm: 300,
	widthMm: 200,
	heightMm: 100,
	weightGrams: 600,
	insureAmount: null,
	rateId,
});

const dispatchOrdersOf = (dispatchId: number) =>
	db
		.select()
		.from(schema.dispatchOrders)
		.where(eq(schema.dispatchOrders.dispatchId, dispatchId));
const boxesOf = (dispatchId: number) =>
	db
		.select()
		.from(schema.shipments)
		.where(eq(schema.shipments.dispatchId, dispatchId));

beforeEach(async () => {
	n = 0;
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
});

describe("buyDispatch", () => {
	test("buys a label per box, for every order in the box", async () => {
		const a = await addOrder("#1");
		const b = await addOrder("#2");
		const outside = fakes();
		const bought = await buyDispatch(
			db,
			{ orderIds: [a, b], contentsKey: "X×2", boxes: [box("g1"), box("g2")] },
			outside,
		);
		expect(bought.failed).toBeNull();
		expect(outside.buyLabel).toHaveBeenCalledTimes(2);
		expect(
			(await boxesOf(bought.dispatchId)).map((x) => x.trackingNumber),
		).toEqual(["94001", "94002"]);
		expect(
			(await dispatchOrdersOf(bought.dispatchId)).map((d) => d.orderId).sort(),
		).toEqual([a, b].sort());
	});

	test("refuses a second shipment while one is live", async () => {
		const a = await addOrder("#1");
		await buyDispatch(
			db,
			{ orderIds: [a], contentsKey: "X", boxes: [box()] },
			fakes(),
		);
		const outside = fakes();
		await expect(
			buyDispatch(
				db,
				{ orderIds: [a], contentsKey: "X", boxes: [box()] },
				outside,
			),
		).rejects.toThrow("already has a label");
		expect(outside.buyLabel).not.toHaveBeenCalled();
	});

	test("two presses at once buy once", async () => {
		const a = await addOrder("#1");
		const outside = fakes();
		const input = { orderIds: [a], contentsKey: "X", boxes: [box()] };
		const results = await Promise.allSettled([
			buyDispatch(db, input, outside),
			buyDispatch(db, input, outside),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(outside.buyLabel).toHaveBeenCalledTimes(1);
	});

	test("won't combine orders to different addresses, or mix services", async () => {
		const a = await addOrder("#1");
		const b = await addOrder("#2", { shipPostalCode: "90210" });
		const outside = fakes();
		await expect(
			buyDispatch(
				db,
				{ orderIds: [a, b], contentsKey: "X", boxes: [box()] },
				outside,
			),
		).rejects.toThrow("same address");
		await expect(
			buyDispatch(
				db,
				{ orderIds: [a], contentsKey: "X", boxes: [box("g1"), box("p1")] },
				outside,
			),
		).rejects.toThrow("same service");
		expect(outside.buyLabel).not.toHaveBeenCalled();
	});

	test("a cancelled order can't be bought for", async () => {
		const a = await addOrder("#1", { cancelledAt: new Date() });
		await expect(
			buyDispatch(
				db,
				{ orderIds: [a], contentsKey: "X", boxes: [box()] },
				fakes(),
			),
		).rejects.toThrow("no longer needs shipping");
	});

	test("a box failing part way refunds the ones bought and leaves nothing live", async () => {
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
		const bought = await buyDispatch(
			db,
			{ orderIds: [a], contentsKey: "X", boxes: [box(), box()] },
			outside,
		);
		expect(bought.failed).toContain("Box 2 of 2 wasn't bought (carrier down)");
		expect(bought.failed).toContain("refunded");
		expect(outside.refund).toHaveBeenCalledWith("tx1");
		const saved = await boxesOf(bought.dispatchId);
		expect(saved).toHaveLength(1);
		expect(saved[0].voidedAt).not.toBeNull();

		// Nothing live, so pressing again works.
		const again = await buyDispatch(
			db,
			{ orderIds: [a], contentsKey: "X", boxes: [box(), box()] },
			fakes(),
		);
		expect(again.failed).toBeNull();
	});

	test("the first box failing changes nothing", async () => {
		const a = await addOrder("#1");
		const outside = fakes({
			buyLabel: vi.fn(async () => {
				throw new Error("bad address");
			}),
		});
		await expect(
			buyDispatch(
				db,
				{ orderIds: [a], contentsKey: "X", boxes: [box()] },
				outside,
			),
		).rejects.toThrow("bad address");
		expect(await db.select().from(schema.dispatches)).toEqual([]);
	});

	test("TikTok orders stay one order, one box", async () => {
		const a = await addOrder("#1", { salesChannel: "TikTok" });
		const outside = fakes();
		await expect(
			buyDispatch(
				db,
				{ orderIds: [a], contentsKey: "X", boxes: [box(), box()] },
				outside,
			),
		).rejects.toThrow("Seller Center");
		expect(outside.tiktokBuy).not.toHaveBeenCalled();
	});
});
