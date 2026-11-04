import { eq } from "drizzle-orm";
import { beforeEach, expect, vi } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createTestDb } from "#/test/db";
import { type BuyOutside, buyDispatch } from "./buy";
import { memoryLocker } from "./dispatch";
import { type Outside, sendTracking } from "./handoff";
import type { OpenReads } from "./live-open";
import type { Lowered } from "./packed";
import { shipmentPlan } from "./quick-ship";

// One order going out in several shipments over time, for the tests of it:
// a fresh database each test with order "1" (3 wrenches, none shipped) in
// db, orderId and lineId, and the steps quick ship and the marketplace take.
//
// The marketplace is a small model of Shopify: open holds what it has left
// to ship of each line (by external id), read live by quick ship and the
// purchase. A handoff takes its units off, cancelling it puts them back,
// and shipping from its own admin (shipOutside) takes units off without
// katasync. The synced count (sync) only changes when a test says so, so
// it can lag as much as a test likes.

export let db: Db;
export let storeId: number;
export let orderId: number;
export let lineId: number;
let n = 0;

export const marketplace = {
	open: new Map<string, number>(),
	// Each fulfillment katasync made, by id: what it shipped.
	fulfillments: new Map<string, Map<string, number>>(),
	// Live reads of open, and whether they fail.
	reads: 0,
	failing: false,
};

const take = (line: string, units: number) =>
	marketplace.open.set(line, (marketplace.open.get(line) ?? 0) - units);

const read = async () => {
	marketplace.reads++;
	if (marketplace.failing) throw new Error("Shopify answered 503");
	return new Map(marketplace.open);
};
export const openReads: OpenReads = { shopify: read, ebay: read };

// Units shipped from the marketplace's own admin, which katasync never sees
// but in what's open.
export const shipOutside = (units: number, line = "line-1") =>
	take(line, units);

export async function addOrder(
	name: string,
	extra: Record<string, unknown> = {},
) {
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
	marketplace.open.set(line.externalId, line.quantity);
	return { orderId: row.id, lineId: line.id };
}

export const buying: BuyOutside = {
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
	open: openReads,
	isTest: () => false,
};

// Quick ship's plan, reading the marketplace model.
export const planOf = (ids = [orderId], lowered: Lowered = []) =>
	shipmentPlan(db, ids, lowered, openReads);

// Buys what quick ship's plan shows for these counts, as the browser would.
export async function buy(lowered: Lowered = [], ids = [orderId]) {
	const plan = await planOf(ids, lowered);
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

// Shopify, as the model: a fulfillment takes what it ships off what's open
// (refusing more than is open, as shopifyFulfill's fit does), and
// cancelling one puts its units back.
export function shopify(): Outside {
	return {
		lock: memoryLocker(),
		shopifyFulfill: vi.fn(async (_order, _tracking, packed) => {
			for (const [line, units] of packed)
				if ((marketplace.open.get(line) ?? 0) < units)
					throw new Error(`Shopify has fewer than ${units} of ${line} open`);
			for (const [line, units] of packed) take(line, units);
			const id = `f-${++n}`;
			marketplace.fulfillments.set(id, new Map(packed));
			const remaining = [...marketplace.open.values()].reduce(
				(sum, u) => sum + u,
				0,
			);
			return { fulfillmentId: id, remaining };
		}),
		shopifyCancel: vi.fn(async (id: string) => {
			for (const [line, units] of marketplace.fulfillments.get(id) ?? [])
				take(line, -units);
			marketplace.fulfillments.delete(id);
		}),
		shopifySaveTracking: vi.fn(async () => {}),
		shopifyRemoveTracking: vi.fn(async () => {}),
		ebayShip: vi.fn(),
		refund: vi.fn(async () => ({ status: "QUEUED" })),
		tiktokShip: vi.fn(),
		tiktokUnits: vi.fn(),
	};
}

// Hands a dispatch off to the Shopify model.
export const handOff = (dispatchId: number) =>
	sendTracking(db, dispatchId, shopify());

// The marketplace's own count, as the next sync writes it.
export const sync = (shippedQuantity: number) =>
	db
		.update(schema.orderLines)
		.set({ shippedQuantity })
		.where(eq(schema.orderLines.id, lineId));

export const packedIn = async (dispatchId: number) =>
	(
		await db
			.select({ quantity: schema.dispatchLines.quantity })
			.from(schema.dispatchLines)
			.where(eq(schema.dispatchLines.dispatchId, dispatchId))
	).map((l) => l.quantity);

export const statusOf = async () =>
	(
		await db
			.select({ status: schema.orders.fulfillmentStatus })
			.from(schema.orders)
			.where(eq(schema.orders.id, orderId))
	)[0].status;

// Gives each test of the file calling it a fresh database and order "1".
export function freshOrder() {
	beforeEach(async () => {
		marketplace.open.clear();
		marketplace.fulfillments.clear();
		marketplace.reads = 0;
		marketplace.failing = false;
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
}

// The database's own reason, under Drizzle's "Failed query" wrapper.
export async function refused(work: Promise<unknown>, why: string) {
	const err = await work.then(
		() => null,
		(e: unknown) => e as Error & { cause?: Error },
	);
	expect(err?.cause?.message ?? err?.message).toContain(why);
}
