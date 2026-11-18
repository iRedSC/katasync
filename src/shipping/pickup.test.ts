import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { isPickup } from "#/channels/shopify/channel-order";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { committedUnits } from "#/inventory/commitments";
import { activate } from "#/inventory/commitments.fixtures";
import { postMovements } from "#/inventory/ledger";
import { type ChannelOrder, ingestOrder } from "#/orders/ingest";
import { orderStatus } from "#/orders/status";
import {
	awaitsPickup,
	inPrintAll,
	needsPacking,
	needsShipping,
} from "#/orders/to-ship";
import { createProduct, createTestDb } from "#/test/db";
import { memoryLocker } from "./dispatch";
import { markDropShip } from "./drop-ship";
import {
	markPickedUp,
	markReadyForPickup,
	type PickupOutside,
	undoPickedUp,
} from "./pickup";
import { assignOrderPins } from "./pins";

let db: Db;
let storeId: number;
let warehouse: number;
let wrench: number;
const stockFrom = new Date("2026-10-01T00:00:00Z");
const LINE = "gid://shopify/LineItem/1";

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
		pickup: true,
		financialStatus: "PAID",
		customerName: "Pat Doe",
		buyerId: null,
		shipCity: null,
		shipRegion: null,
		shipCountry: null,
		shipAddress1: null,
		shipAddress2: null,
		shipPostalCode: null,
		shipPhone: null,
		total: 40,
		shippingCharged: 0,
		tax: { remittedBy: "seller", lines: [] },
		sourceUpdatedAt: new Date("2026-10-05T12:00:00Z"),
		lines: [
			{
				externalId: LINE,
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

function fakes(): PickupOutside {
	return {
		lock: memoryLocker(),
		ready: vi.fn(async () => {}),
		open: vi.fn(async () => ({
			units: new Map([[LINE, 2]]),
			fulfillmentOrders: ["gid://shopify/FulfillmentOrder/1"],
		})),
		fulfill: vi.fn(async () => ({
			fulfillmentId: "gid://shopify/Fulfillment/1",
			remaining: 0,
		})),
		unfulfill: vi.fn(async () => {}),
		reread: vi.fn(async () => {}),
	};
}

const at = new Date("2026-10-05T12:00:00Z");
async function sold(extra: Partial<ChannelOrder> = {}) {
	const { orderId } = await ingestOrder(
		db,
		{ id: storeId, stockFrom },
		order(extra),
		{ shipping: warehouse, store: null, pos: null, storeKeeps: 0 },
	);
	await assignOrderPins(db);
	return orderId;
}

async function row(id: number) {
	const [o] = await db
		.select({
			pin: schema.orders.pin,
			pickup: schema.orders.pickup,
			readyForPickupAt: schema.orders.readyForPickupAt,
			fulfillmentStatus: schema.orders.fulfillmentStatus,
			needsShipping,
			needsPacking,
			awaitsPickup,
			inPrintAll,
		})
		.from(schema.orders)
		.where(eq(schema.orders.id, id));
	return o;
}

beforeEach(async () => {
	db = await createTestDb();
	[{ id: storeId }] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify", stockFrom })
		.returning();
	[{ id: warehouse }] = await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" })
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

async function onHand() {
	const [level] = await db
		.select()
		.from(schema.stockLevels)
		.where(eq(schema.stockLevels.productId, wrench));
	return level?.onHand ?? 0;
}
const reserved = async () =>
	(await committedUnits(db, [wrench])).get(wrench) ?? 0;

describe("isPickup", () => {
	const of = (...methods: (string | null)[]) => ({
		fulfillmentOrders: {
			pageInfo: { hasNextPage: false },
			nodes: methods.map((m) => ({
				deliveryMethod: m === null ? null : { methodType: m },
			})),
		},
	});
	test("only when every part of it is picked up", () => {
		expect(isPickup(of("PICK_UP"))).toBe(true);
		expect(isPickup(of("PICK_UP", "PICK_UP"))).toBe(true);
		// Some of it ships, so all of it goes in the box.
		expect(isPickup(of("PICK_UP", "SHIPPING"))).toBe(false);
		expect(isPickup(of(null))).toBe(false);
		expect(isPickup(of())).toBe(false);
		// More than one read holds: the rest might ship.
		const many = of("PICK_UP");
		expect(
			isPickup({
				fulfillmentOrders: {
					...many.fulfillmentOrders,
					pageInfo: { hasNextPage: true },
				},
			}),
		).toBe(false);
	});
});

describe("a pickup on To ship", () => {
	test("is still to do and prints, but never gets a pin or a box", async () => {
		const id = await sold();
		expect(await row(id)).toMatchObject({
			pin: null,
			needsShipping: true,
			needsPacking: false,
			awaitsPickup: true,
			inPrintAll: true,
		});
	});

	test("can't be made a drop-ship", async () => {
		const id = await sold();
		await expect(
			markDropShip(db, id, {
				lock: memoryLocker(),
				shopifyFulfill: vi.fn(),
				ebayShip: vi.fn(),
			}),
		).rejects.toThrow();
	});

	test("a sync turning it into a shipment gives it a pin and forgets ready", async () => {
		const id = await sold();
		await markReadyForPickup(db, id, fakes());
		await sold({
			pickup: false,
			sourceUpdatedAt: new Date(at.getTime() + 1000),
		});
		expect(await row(id)).toMatchObject({
			pickup: false,
			readyForPickupAt: null,
			needsPacking: true,
		});
		expect((await row(id)).pin).not.toBeNull();
	});
});

describe("markReadyForPickup", () => {
	test("tells Shopify once and turns the badge to ready", async () => {
		const id = await sold();
		const outside = fakes();
		await markReadyForPickup(db, id, outside);
		expect(outside.ready).toHaveBeenCalledWith("gid://shopify/Order/1");
		const after = await row(id);
		expect(after.readyForPickupAt).not.toBeNull();
		expect(
			orderStatus({
				...base,
				pickup: true,
				readyForPickupAt: after.readyForPickupAt,
			}).key,
		).toBe("ready");

		await expect(markReadyForPickup(db, id, outside)).rejects.toThrow(
			"already ready",
		);
		expect(outside.ready).toHaveBeenCalledTimes(1);
	});

	test("refuses an order that ships", async () => {
		const id = await sold({ pickup: false });
		const outside = fakes();
		await expect(markReadyForPickup(db, id, outside)).rejects.toThrow(
			"isn't a pickup",
		);
		expect(outside.ready).not.toHaveBeenCalled();
	});

	test("Shopify refusing leaves it not ready", async () => {
		const id = await sold();
		const outside = fakes();
		outside.ready = vi.fn(async () => {
			throw new Error("Shopify refused: nope");
		});
		await expect(markReadyForPickup(db, id, outside)).rejects.toThrow("nope");
		expect((await row(id)).readyForPickupAt).toBeNull();
	});
});

describe("markPickedUp", () => {
	test("fulfills everything open with no tracking and leaves To ship", async () => {
		const id = await sold();
		const outside = fakes();
		const r = await markPickedUp(db, id, outside);
		expect(outside.fulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/1",
			null,
			new Map([[LINE, 2]]),
			"exactly",
		);
		expect(outside.reread).toHaveBeenCalled();
		expect(r.problems).toEqual([]);
		expect(await row(id)).toMatchObject({
			fulfillmentStatus: "FULFILLED",
			needsShipping: false,
		});
		await expect(markPickedUp(db, id, outside)).rejects.toThrow(
			"already picked up",
		);
	});

	test("a failed read back still counts as picked up", async () => {
		const id = await sold();
		const outside = fakes();
		outside.reread = vi.fn(async () => {
			throw new Error("timeout");
		});
		const r = await markPickedUp(db, id, outside);
		expect(r.problems).toEqual([expect.stringContaining("next sync")]);
		expect((await row(id)).needsShipping).toBe(false);
	});

	test("nothing open on Shopify sends nothing", async () => {
		const id = await sold();
		const outside = fakes();
		outside.open = vi.fn(async () => ({
			units: new Map(),
			fulfillmentOrders: [],
		}));
		await expect(markPickedUp(db, id, outside)).rejects.toThrow("on hold");
		expect(outside.fulfill).not.toHaveBeenCalled();
	});

	test("undo cancels only the fulfillment it made, once", async () => {
		const id = await sold();
		const outside = fakes();
		await expect(undoPickedUp(db, id, outside)).rejects.toThrow(
			"no pickup to take back",
		);
		await markPickedUp(db, id, outside);
		await undoPickedUp(db, id, outside);
		expect(outside.unfulfill).toHaveBeenCalledWith(
			"gid://shopify/Fulfillment/1",
		);
		expect(outside.reread).toHaveBeenCalledTimes(2);
		await expect(undoPickedUp(db, id, outside)).rejects.toThrow(
			"no pickup to take back",
		);
		expect(outside.unfulfill).toHaveBeenCalledTimes(1);
	});

	test("in committed stock, its units leave the shelf and undo holds them again", async () => {
		await activate(db);
		const id = await sold();
		expect(await reserved()).toBe(2);
		expect(await onHand()).toBe(10);

		const outside = fakes();
		expect((await markPickedUp(db, id, outside)).problems).toEqual([]);
		expect(await reserved()).toBe(0);
		expect(await onHand()).toBe(8);

		await undoPickedUp(db, id, outside);
		expect(await reserved()).toBe(2);
		expect(await onHand()).toBe(10);
	});
});

const base = {
	cancelledAt: null,
	fulfillmentStatus: "UNFULFILLED",
	financialStatus: "PAID",
	channel: "shopify",
	salesChannel: "Online Store",
	marketplaceOrderId: null,
	externalId: "gid://shopify/Order/1",
	shipCountry: null,
	labelToVoid: false,
	fulfilledByChannel: false,
	dropShipAt: null,
	pickup: false,
	readyForPickupAt: null,
	remainingUnknown: false,
	returnStage: null,
};
