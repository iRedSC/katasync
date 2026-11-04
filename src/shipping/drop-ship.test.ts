import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { committedUnits } from "#/inventory/commitments";
import { activate } from "#/inventory/commitments.fixtures";
import { postMovements } from "#/inventory/ledger";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { reconcileStock } from "#/orders/reconcile-stock";
import { needsShipping } from "#/orders/to-ship";
import { addDispatch, createProduct, createTestDb } from "#/test/db";
import { memoryLocker } from "./dispatch";
import {
	type DropShipOutside,
	markDropShip,
	sendDropShipTracking,
	unmarkDropShip,
} from "./drop-ship";
import { assignOrderPins } from "./pins";

let db: Db;
let warehouse: number;
let storeId: number;
let wrench: number;
const stockFrom = new Date("2026-10-01T00:00:00Z");

const from = () => ({
	shipping: warehouse,
	store: null,
	pos: null,
	storeKeeps: 0,
});

function order(extra: Partial<ChannelOrder> = {}): ChannelOrder {
	return {
		externalId: "gid://shopify/Order/1",
		name: "#1001",
		salesChannel: "Online Store",
		marketplaceOrderId: null,
		placedAt: new Date("2026-10-05T12:00:00Z"),
		cancelledAt: null,
		fulfillmentStatus: "UNFULFILLED",
		fulfilledByChannel: false,
		soldInStore: false,
		financialStatus: "PAID",
		customerName: "Pat Doe",
		buyerId: null,
		shipCity: "Harrisburg",
		shipRegion: "PA",
		shipCountry: "US",
		shipAddress1: "1 Main St",
		shipAddress2: null,
		shipPostalCode: "17101",
		shipPhone: null,
		total: 50,
		shippingCharged: 10,
		tax: { remittedBy: "seller", lines: [] },
		sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
		lines: [
			{
				externalId: "gid://shopify/LineItem/1",
				listingExternalId: null,
				sku: "WRENCH",
				title: "Wrench",
				quantity: 2,
				shipped: 0,
				unitPrice: 20,
			},
		],
		...extra,
	};
}

function fakes(): DropShipOutside {
	return {
		lock: memoryLocker(),
		shopifyFulfill: vi.fn(async () => ({
			fulfillmentId: "gid://shopify/Fulfillment/1",
			remaining: 0,
		})),
		ebayShip: vi.fn(async () => ({ fulfillmentId: "ebay-1", remaining: 0 })),
	};
}

async function onHand() {
	const [row] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, wrench));
	return row?.onHand ?? 0;
}

const orderRow = async (id: number) =>
	(await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];

async function sold(extra: Partial<ChannelOrder> = {}) {
	const { orderId } = await ingestOrder(
		db,
		{ id: storeId, stockFrom },
		order(extra),
		from(),
	);
	await assignOrderPins(db);
	return orderId;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
		.returning();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify", stockFrom })
		.returning();
	wrench = await createProduct(db, "WRENCH", "simple");
	await postMovements(db, {
		lines: [
			{
				productId: wrench,
				locationId: warehouse,
				delta: 10,
				reason: "opening_balance",
			},
		],
	});
});

describe("markDropShip", () => {
	test("gives its stock back and its pin up, and a later sync takes neither", async () => {
		const id = await sold();
		expect(await onHand()).toBe(8);
		expect((await orderRow(id)).pin).not.toBeNull();

		await markDropShip(db, id, fakes());
		expect(await onHand()).toBe(10);
		expect((await orderRow(id)).pin).toBeNull();

		// The channel sends the order again, and the catch-up runs.
		await sold({ sourceUpdatedAt: new Date("2026-10-06T00:00:00Z") });
		await reconcileStock(db, from());
		await assignOrderPins(db);
		expect(await onHand()).toBe(10);
		expect((await orderRow(id)).pin).toBeNull();
	});

	test("is refused while the order has a label, and a drop-ship can't get one", async () => {
		const id = await sold();
		const { dispatchId } = await addDispatch(db, { orderIds: [id] });
		await expect(markDropShip(db, id, fakes())).rejects.toThrow("has a label");
		expect(await onHand()).toBe(8);

		await db
			.update(schema.shipments)
			.set({ voidedAt: new Date() })
			.where(eq(schema.shipments.dispatchId, dispatchId));
		await markDropShip(db, id, fakes());
		await expect(addDispatch(db, { orderIds: [id] })).rejects.toThrow();
	});

	test("is refused for a partly shipped order", async () => {
		const id = await sold({ fulfillmentStatus: "PARTIALLY_FULFILLED" });
		await expect(markDropShip(db, id, fakes())).rejects.toThrow(
			"partly shipped",
		);
		expect(await onHand()).toBe(8);
	});

	test("is refused once the order isn't waiting to be packed", async () => {
		const id = await sold({ cancelledAt: new Date("2026-10-06T00:00:00Z") });
		await expect(markDropShip(db, id, fakes())).rejects.toThrow(
			"isn't waiting to be packed",
		);
	});
});

describe("in committed stock", () => {
	test("marking lets go of the reservation and unmarking makes it again", async () => {
		await activate(db);
		const id = await sold();
		const reserved = async () =>
			(await committedUnits(db, [wrench])).get(wrench) ?? 0;
		expect(await reserved()).toBe(2);

		await markDropShip(db, id, fakes());
		expect(await reserved()).toBe(0);
		await sold({ sourceUpdatedAt: new Date("2026-10-06T00:00:00Z") });
		await reconcileStock(db, from());
		expect(await reserved()).toBe(0);

		await unmarkDropShip(db, id, fakes());
		expect(await reserved()).toBe(2);
		expect(await onHand()).toBe(10);
	});
});

describe("unmarkDropShip", () => {
	test("takes the stock again and gives it a pin", async () => {
		const id = await sold();
		await markDropShip(db, id, fakes());
		const { problems } = await unmarkDropShip(db, id, fakes());
		expect(problems).toEqual([]);
		expect(await onHand()).toBe(8);
		const row = await orderRow(id);
		expect(row.dropShipAt).toBeNull();
		expect(row.pin).not.toBeNull();
	});

	test("is refused once the supplier's tracking went out", async () => {
		const id = await sold();
		const outside = fakes();
		await markDropShip(db, id, outside);
		await sendDropShipTracking(db, id, null, outside);
		await expect(unmarkDropShip(db, id, outside)).rejects.toThrow(
			"already shipped",
		);
		expect(await onHand()).toBe(10);
	});
});

describe("sendDropShipTracking", () => {
	test("a refusal leaves it waiting; a lost answer keeps it from going back to pack", async () => {
		const id = await sold();
		const outside = fakes();
		await markDropShip(db, id, outside);
		outside.shopifyFulfill = vi.fn(async () => {
			throw new Error("Shopify refused: no");
		});
		await expect(sendDropShipTracking(db, id, null, outside)).rejects.toThrow(
			"refused",
		);
		expect((await orderRow(id)).dropShipSentAt).toBeNull();

		outside.shopifyFulfill = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(sendDropShipTracking(db, id, null, outside)).rejects.toThrow(
			"fetch failed",
		);
		await expect(unmarkDropShip(db, id, outside)).rejects.toThrow(
			"already shipped",
		);
		expect(await onHand()).toBe(10);
	});

	test("tells Shopify every line shipped with the supplier's tracking", async () => {
		const id = await sold();
		const outside = fakes();
		await markDropShip(db, id, outside);

		await sendDropShipTracking(
			db,
			id,
			{ carrier: "UPS", number: "1z 999 aa1 01 2345 6784" },
			outside,
		);
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/1",
			{
				company: "UPS",
				boxes: [{ number: "1Z999AA10123456784", url: null }],
			},
			new Map([["gid://shopify/LineItem/1", 2]]),
		);
		const row = await orderRow(id);
		expect(row).toMatchObject({
			fulfillmentStatus: "FULFILLED",
			dropShipCarrier: "UPS",
			dropShipTracking: "1Z999AA10123456784",
		});
		const [left] = await db
			.select({ needsShipping })
			.from(schema.orders)
			.where(eq(schema.orders.id, id));
		expect(left.needsShipping).toBe(false);
		expect(await onHand()).toBe(10);
	});

	test("sends without tracking when the supplier never gave any", async () => {
		const id = await sold();
		const outside = fakes();
		await markDropShip(db, id, outside);
		await sendDropShipTracking(db, id, null, outside);
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/1",
			null,
			expect.any(Map),
		);
		expect(await orderRow(id)).toMatchObject({
			dropShipTracking: null,
			dropShipCarrier: null,
		});
		expect((await orderRow(id)).dropShipSentAt).not.toBeNull();
	});

	test("sends nothing for an order that was never marked, or one sold on TikTok", async () => {
		const id = await sold();
		const outside = fakes();
		await expect(sendDropShipTracking(db, id, null, outside)).rejects.toThrow(
			"isn't a drop-ship",
		);
		await db
			.update(schema.orders)
			.set({ salesChannel: "TikTok" })
			.where(eq(schema.orders.id, id));
		await markDropShip(db, id, outside);
		await expect(sendDropShipTracking(db, id, null, outside)).rejects.toThrow(
			"on TikTok",
		);
		expect(outside.shopifyFulfill).not.toHaveBeenCalled();
	});
});
