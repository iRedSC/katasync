import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("#/channels/tiktok", () => ({
	shopCipher: async () => "cipher",
	tiktokApi: vi.fn(),
}));

import { orderSummary } from "#/buyers/order";
import { tiktokApi } from "#/channels/tiktok";
import type { Db } from "#/db/client";
import {
	dispatches,
	dispatchOrders,
	orders,
	shipments,
	stores,
} from "#/db/schema";
import { createTestDb } from "#/test/db";
import { carrierOf } from "./channel-tracking";

// A TikTok order whose label was bought in Seller Center: katasync has no
// shipment, TikTok says FedEx 384131747581.

let db: Db;
let orderId: number;
const changed = new Date("2026-10-20T00:00:00Z");

beforeEach(async () => {
	db = await createTestDb();
	vi.stubEnv("SHIPPO_API_KEY", "shippo_test");
	const [store] = await db
		.insert(stores)
		.values({ channel: "tiktok", name: "TikTok Shop" })
		.returning();
	const [order] = await db
		.insert(orders)
		.values({
			storeId: store?.id ?? 0,
			externalId: "5776",
			name: "5776",
			placedAt: changed,
			fulfillmentStatus: "FULFILLED",
			total: 40,
			sourceUpdatedAt: changed,
		})
		.returning();
	orderId = order?.id ?? 0;
	vi.mocked(tiktokApi).mockReset();
	vi.mocked(tiktokApi).mockResolvedValue({
		orders: [
			{
				tracking_number: "384131747581",
				shipping_provider: "FedEx",
				// Two lines in one box, and one in a box of ours.
				line_items: [
					{ tracking_number: "384131747581", shipping_provider_name: "FedEx" },
					{ tracking_number: "384131747581", shipping_provider_name: "FedEx" },
					{ tracking_number: "9400 111", shipping_provider_name: "USPS" },
				],
			},
		],
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						tracking_status: {
							status: "DELIVERED",
							status_details: "Delivered, Front Door/Porch",
							status_date: "2026-10-22T10:00:00Z",
						},
						tracking_history: [
							{ status: "TRANSIT", status_details: "Picked up" },
							{
								status: "DELIVERED",
								status_details: "Delivered, Front Door/Porch",
							},
						],
					}),
				),
		),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function ourLabel(number: string, voided: boolean) {
	const [d] = await db
		.insert(dispatches)
		.values({ contentsKey: "k" })
		.returning();
	await db.insert(dispatchOrders).values({ dispatchId: d?.id ?? 0, orderId });
	await db.insert(shipments).values({
		dispatchId: d?.id ?? 0,
		lengthMm: 1,
		widthMm: 1,
		heightMm: 1,
		weightGrams: 1,
		provider: "tiktok",
		carrier: "USPS",
		service: "ground",
		serviceName: "Ground Advantage",
		cost: 5,
		trackingNumber: number,
		externalId: "s1",
		test: false,
		voidedAt: voided ? new Date() : null,
	});
}

test("a package shipped on the channel's label shows with every scan, once", async () => {
	await ourLabel("9400111", true);
	const { packages } = await orderSummary(db, orderId);
	// Our voided label's number isn't shown again as the channel's.
	expect(packages).toMatchObject([
		{
			carrier: "FedEx",
			number: "384131747581",
			url: "https://www.fedex.com/fedextrack/?trknbr=384131747581",
			tracking: {
				state: "fresh",
				t: {
					carrier: "fedex",
					status: "DELIVERED",
					history: [
						{ detail: "Picked up" },
						{ detail: "Delivered, Front Door/Porch" },
					],
				},
			},
		},
	]);
	// Asked once until the order changes.
	await orderSummary(db, orderId);
	expect(tiktokApi).toHaveBeenCalledTimes(1);
	await db.update(orders).set({ sourceUpdatedAt: new Date() });
	await orderSummary(db, orderId);
	expect(tiktokApi).toHaveBeenCalledTimes(2);
});

test("a channel that can't be asked keeps what was known, and says so", async () => {
	await orderSummary(db, orderId);
	await db.update(orders).set({ sourceUpdatedAt: new Date() });
	vi.mocked(tiktokApi).mockRejectedValue(new Error("down"));
	const { packages, channel } = await orderSummary(db, orderId);
	expect(packages.map((p) => p.number)).toEqual(["384131747581", "9400 111"]);
	expect(channel).toEqual({ state: "stale", why: "down", name: "tiktok" });
});

test("a channel never read that can't be asked fails, not empty", async () => {
	vi.mocked(tiktokApi).mockRejectedValue(new Error("down"));
	const { packages, channel } = await orderSummary(db, orderId);
	expect(packages).toEqual([]);
	expect(channel).toEqual({ state: "failed", why: "down", name: "tiktok" });
});

test("carriers by name, or by the number's shape", () => {
	expect(carrierOf("FEDEX", "1")).toBe("fedex");
	expect(carrierOf("UPS Ground", "1")).toBe("ups");
	expect(carrierOf("United States Postal Service", "1")).toBe("usps");
	expect(carrierOf("Other", "1Z999AA10123456784")).toBe("ups");
	expect(carrierOf("Other", "123")).toBeNull();
});
