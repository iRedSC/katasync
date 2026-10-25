import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	orderLines,
	orders,
	shipments,
	stores,
} from "#/db/schema";
import { createTestDb } from "#/test/db";
import { buyerOrder } from "./order";
import { ensureThread } from "./threads";

let db: Db;
beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("SHIPPO_API_KEY", "shippo_test");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function shippedOrder(carrier: string, url: string | null) {
	const [store] = await db
		.insert(stores)
		.values({ channel: "amazon", name: "Amazon" })
		.returning();
	const [order] = await db
		.insert(orders)
		.values({
			storeId: store?.id ?? 0,
			externalId: "113-1",
			name: "113-1",
			placedAt: new Date(),
			fulfillmentStatus: "Shipped",
			total: 40,
			sourceUpdatedAt: new Date(),
		})
		.returning();
	await db.insert(orderLines).values({
		orderId: order?.id ?? 0,
		externalId: "l1",
		title: "Corner applicator",
		quantity: 2,
		unitPrice: 20,
	});
	const [d] = await db
		.insert(dispatches)
		.values({ contentsKey: "k" })
		.returning();
	await db
		.insert(dispatchOrders)
		.values({ dispatchId: d?.id ?? 0, orderId: order?.id ?? 0 });
	await db.insert(shipments).values({
		dispatchId: d?.id ?? 0,
		lengthMm: 1,
		widthMm: 1,
		heightMm: 1,
		weightGrams: 1,
		provider: "tiktok",
		carrier,
		service: "ground",
		serviceName: "Ground Advantage",
		cost: 5,
		trackingNumber: "9400111",
		trackingUrl: url,
		externalId: "s1",
		test: false,
	});
	const t = await ensureThread(db, {
		market: "amazon",
		externalId: "buyer@marketplace.amazon.com",
		subject: "Where is it",
		orderRef: "113-1",
	});
	return t.id;
}

test("the order's products and where each package is", async () => {
	const threadId = await shippedOrder("USPS", null);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						tracking_status: {
							status: "TRANSIT",
							status_details: "Arrived at USPS facility",
							status_date: "2026-10-22T10:00:00Z",
						},
						eta: "2026-10-24T20:00:00Z",
					}),
				),
		),
	);
	const o = await buyerOrder(db, threadId);
	expect(o?.lines).toMatchObject([{ title: "Corner applicator", quantity: 2 }]);
	expect(o?.packages).toMatchObject([
		{
			carrier: "USPS",
			number: "9400111",
			// TikTok labels have none of their own: the carrier's page.
			url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111",
			tracking: {
				state: "fresh",
				t: {
					status: "TRANSIT",
					statusDetail: "Arrived at USPS facility",
					eta: new Date("2026-10-24T20:00:00Z"),
				},
			},
		},
	]);
});

test("a carrier that can't be asked leaves what katasync knows", async () => {
	const threadId = await shippedOrder("FedEx", "https://x.example/t");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("down", { status: 503 })),
	);
	const [p] = (await buyerOrder(db, threadId))?.packages ?? [];
	expect(p).toMatchObject({
		url: "https://x.example/t",
		tracking: { state: "failed", why: expect.stringContaining("503") },
	});
});

test("a refresh that fails after an answer keeps its scans, stale", async () => {
	const threadId = await shippedOrder("USPS", null);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				tracking_status: { status: "TRANSIT" },
				tracking_history: [{ status: "TRANSIT", status_details: "Picked up" }],
			}),
		),
	);
	await buyerOrder(db, threadId);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("down", { status: 503 })),
	);
	const [p] = (await buyerOrder(db, threadId))?.packages ?? [];
	expect(p?.tracking).toMatchObject({
		state: "stale",
		why: expect.stringContaining("503"),
		t: { status: "TRANSIT", history: [{ detail: "Picked up" }] },
	});
});

test("a package without a number, or with a carrier Shippo can't follow", async () => {
	const threadId = await shippedOrder("DHL", null);
	await db.update(shipments).set({ trackingNumber: "JD01" });
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	expect((await buyerOrder(db, threadId))?.packages[0]?.tracking).toEqual({
		state: "unsupported",
	});
	await db.update(shipments).set({ trackingNumber: null });
	expect((await buyerOrder(db, threadId))?.packages[0]?.tracking).toEqual({
		state: "untracked",
	});
	expect(fetch).not.toHaveBeenCalled();
});
