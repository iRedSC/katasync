import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { remainingUnknown } from "#/orders/to-ship";
import { createTestDb } from "#/test/db";
import { setOpen, syncedOpen } from "#/test/open-reads";
import { type BuyOutside, buyDispatch } from "./buy";
import { contentsKey } from "./contents";
import { memoryLocker, whyNotTogether } from "./dispatch";
import { type Outside, sendTracking, voidDispatch } from "./handoff";
import { contentsOf } from "./packed";
import { shipmentPlan } from "./quick-ship";

// An order the marketplace partly shipped from its own admin: quick ship
// packs only what's left, the purchase keeps that, and the handoff tells
// the marketplace exactly that and records it shipped. Shopify's open
// counts here agree with the sync unless a test says otherwise.

let db: Db;
let orderId: number;

async function addOrder(
	fulfillmentStatus: string,
	lines: { externalId: string; quantity: number; shipped: number | null }[],
) {
	const [store] = await db
		.insert(schema.stores)
		.values({ channel: "shopify", name: "Shopify" })
		.returning();
	const [order] = await db
		.insert(schema.orders)
		.values({
			storeId: store.id,
			externalId: "gid://shopify/Order/9",
			name: "#9",
			placedAt: new Date(),
			fulfillmentStatus,
			total: 60,
			sourceUpdatedAt: new Date(),
			shipAddress1: "12 Oak St",
			shipCity: "Erie",
			shipPostalCode: "16501",
			shipCountry: "US",
		})
		.returning();
	orderId = order.id;
	await db.insert(schema.orderLines).values(
		lines.map((l) => ({
			orderId,
			externalId: l.externalId,
			sku: l.externalId,
			title: l.externalId,
			quantity: l.quantity,
			shippedQuantity: l.shipped,
			unitPrice: 10,
		})),
	);
}

const buyOutside = (): BuyOutside => ({
	lock: memoryLocker(),
	getRates: vi.fn(async () => ({
		rates: [
			{
				id: "g1",
				carrier: "USPS",
				service: "ground",
				serviceName: "USPS Ground Advantage",
				cost: 7,
				days: 3,
			},
		],
		notes: [],
	})),
	buyLabel: vi.fn(async (rateId: string) => ({
		id: `tx-${rateId}`,
		labelUrl: "https://example.com/l.pdf",
		trackingNumber: "9400100",
		trackingUrl: null,
	})),
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
	tiktokUnits: vi.fn(),
	open: syncedOpen(() => db),
	isTest: () => false,
});

const handoffOutside = (remaining: number): Outside => ({
	lock: memoryLocker(),
	shopifyFulfill: vi.fn(async () => ({ fulfillmentId: "f1", remaining })),
	shopifyCancel: vi.fn(async () => {}),
	shopifySaveTracking: vi.fn(async () => {}),
	shopifyRemoveTracking: vi.fn(async () => {}),
	ebayShip: vi.fn(),
	refund: vi.fn(async () => ({ status: "QUEUED" })),
	tiktokShip: vi.fn(),
	tiktokUnits: vi.fn(),
});

// Quick ship's plan, with Shopify agreeing with the sync unless told.
const planOf = (open = syncedOpen(db)) => shipmentPlan(db, [orderId], [], open);

const buy = async (contents: string, open = syncedOpen(db)) =>
	buyDispatch(
		db,
		{
			orderIds: [orderId],
			contentsKey: contents,
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
		{ ...buyOutside(), open },
	);

const shippedOf = async () =>
	(
		await db
			.select({
				line: schema.orderLines.externalId,
				shipped: schema.orderLines.shippedQuantity,
			})
			.from(schema.orderLines)
			.where(eq(schema.orderLines.orderId, orderId))
			.orderBy(schema.orderLines.externalId)
	).map((l) => [l.line, l.shipped]);

beforeEach(async () => {
	vi.stubEnv("TRACKING_LINK_SECRET", "test-tracking-secret");
	vi.stubEnv("STOREFRONT_ORIGIN", "https://storefront.example.com");
	db = await createTestDb();
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

afterEach(() => vi.unstubAllEnvs());

describe("a partly shipped order", () => {
	beforeEach(() =>
		addOrder("PARTIALLY_FULFILLED", [
			{ externalId: "BLADE", quantity: 5, shipped: 2 },
			{ externalId: "KNIFE", quantity: 1, shipped: 1 },
			// A channel saying more went than sold means none is left.
			{ externalId: "TAPE", quantity: 2, shipped: 3 },
		]),
	);

	test("quick ship plans only what's left", async () => {
		const plan = await planOf();
		expect(plan.lines.map((l) => [l.sku, l.quantity])).toEqual([["BLADE", 3]]);
		expect(plan.contentsKey).toBe(
			contentsKey([{ sku: "BLADE", title: "BLADE", quantity: 3 }]),
		);
	});

	test("buying keeps the rest as packed, and the handoff ships it", async () => {
		const plan = await planOf();
		const bought = await buy(plan.contentsKey);
		expect(bought.failed).toBeNull();
		const contents = await contentsOf(db, bought.dispatchId);
		expect(contents).toMatchObject({
			kind: "packed",
			lines: [{ lineExternalId: "BLADE", quantity: 3 }],
		});

		const outside = handoffOutside(0);
		expect((await sendTracking(db, bought.dispatchId, outside)).sent).toBe(
			true,
		);
		// What Shopify still has open, as one shipment of several.
		expect(outside.shopifyFulfill).toHaveBeenCalledWith(
			"gid://shopify/Order/9",
			expect.anything(),
			new Map([["BLADE", 3]]),
			"within",
		);
		const [order] = await db
			.select()
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId));
		expect(order.fulfillmentStatus).toBe("FULFILLED");
	});

	// Only the marketplace's sync writes shipped counts (orders/ingest.ts):
	// a second writer here would double-count against a sync landing at the
	// same time.
	test("the handoff and its void leave shipped counts to the sync", async () => {
		const asSynced = [
			["BLADE", 2],
			["KNIFE", 1],
			["TAPE", 3],
		];
		const plan = await planOf();
		const bought = await buy(plan.contentsKey);
		const outside = handoffOutside(0);
		await sendTracking(db, bought.dispatchId, outside);
		expect(await shippedOf()).toEqual(asSynced);

		await voidDispatch(db, bought.dispatchId, outside);
		expect(outside.shopifyCancel).toHaveBeenCalledWith("f1");
		expect(await shippedOf()).toEqual(asSynced);
		const [order] = await db
			.select()
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId));
		expect(order.fulfillmentStatus).toBe("UNFULFILLED");
	});
});

describe("an order partly shipped where the sync hasn't said what", () => {
	beforeEach(() =>
		addOrder("PARTIALLY_FULFILLED", [
			{ externalId: "BLADE", quantity: 5, shipped: null },
		]),
	);

	test("packs what Shopify says is open, read live", async () => {
		const shopify = setOpen(new Map([["BLADE", 3]]));
		const plan = await planOf(shopify.as);
		expect(plan.lines.map((l) => [l.sku, l.quantity])).toEqual([["BLADE", 3]]);
		const bought = await buy(plan.contentsKey, shopify.as);
		expect(bought.failed).toBeNull();
		expect(await contentsOf(db, bought.dispatchId)).toMatchObject({
			lines: [{ lineExternalId: "BLADE", quantity: 3 }],
		});
	});

	test("whyNotTogether refuses it only where nothing is read live", () => {
		const order = {
			id: 1,
			name: "#9",
			channel: "shopify",
			salesChannel: "Online Store",
			marketplaceOrderId: null,
			externalId: "9",
			needsPacking: true,
			remainingUnknown: true,
			shipAddress1: "12 Oak St",
			shipAddress2: null,
			shipPostalCode: "16501",
			shipCountry: "US",
			storeId: 1,
			buyerId: null,
		};
		expect(whyNotTogether([order], [])).toBeNull();
		expect(
			whyNotTogether(
				[{ ...order, channel: "tiktok", marketplaceOrderId: "tiktok:9" }],
				[],
			),
		).toContain("Ship it there");
	});
});

test("a void doesn't turn an unknown count into nothing shipped", async () => {
	// Shopify shipped 2 of 5 from its own admin.
	await addOrder("PARTIALLY_FULFILLED", [
		{ externalId: "BLADE", quantity: 5, shipped: 2 },
	]);
	const sync = (shipped: number | null) =>
		db
			.update(schema.orderLines)
			.set({ shippedQuantity: shipped })
			.where(eq(schema.orderLines.orderId, orderId));
	const unknown = async () =>
		(
			await db
				.select({ unknown: remainingUnknown })
				.from(schema.orders)
				.where(eq(schema.orders.id, orderId))
		)[0].unknown;

	// katasync ships the other 3; a sync then can't give a count.
	const bought = await buy((await planOf()).contentsKey);
	const outside = handoffOutside(0);
	await sendTracking(db, bought.dispatchId, outside);
	await sync(null);

	await voidDispatch(db, bought.dispatchId, outside);
	const [order] = await db
		.select()
		.from(schema.orders)
		.where(eq(schema.orders.id, orderId));
	expect(order.fulfillmentStatus).toBe("UNFULFILLED");
	// Still shown as unknown, not all 5: 2 already went out from Shopify.
	expect(await unknown()).toBe(true);
	// Quick ship packs what Shopify has open after the void.
	const shopify = setOpen(new Map([["BLADE", 3]]));
	expect(
		(await planOf(shopify.as)).lines.map((l) => [l.sku, l.quantity]),
	).toEqual([["BLADE", 3]]);
});
