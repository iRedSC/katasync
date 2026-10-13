import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("#/channels/tiktok", () => ({
	shopCipher: async () => "cipher",
	tiktokApi: vi.fn(),
}));

import { tiktokApi } from "#/channels/tiktok";
import { labelPrice, tiktokBuyLabel } from "./tiktok";

const parcel = {
	lengthMm: 300,
	widthMm: 200,
	heightMm: 100,
	weightGrams: 600,
};

beforeEach(() => vi.mocked(tiktokApi).mockReset());

describe("tiktokBuyLabel", () => {
	test("recovers a package TikTok already made instead of buying another", async () => {
		vi.mocked(tiktokApi).mockImplementation(async (...args) => {
			const [path] = args;
			if (path === "/order/202309/orders") {
				return {
					orders: [
						{
							id: "577",
							status: "AWAITING_COLLECTION",
							packages: [{ id: "pkg-1" }],
							line_items: [{ id: "u1" }],
						},
					],
				};
			}
			if (path === "/fulfillment/202309/packages/pkg-1") {
				return { shipping_provider_name: "USPS" };
			}
			return undefined;
		});

		const label = await tiktokBuyLabel("577", parcel, "svc-1");

		expect(label).toMatchObject({
			packageId: "pkg-1",
			recovered: true,
			rate: { carrier: "USPS", cost: 0 },
		});
		expect(vi.mocked(tiktokApi).mock.calls.map(([path]) => path)).toEqual([
			"/order/202309/orders",
			"/fulfillment/202309/packages/pkg-1",
		]);
	});

	test("buys while the order still awaits shipment, even with a package listed", async () => {
		vi.mocked(tiktokApi).mockImplementation(async (...args) => {
			const [path] = args;
			if (path === "/order/202309/orders") {
				return {
					orders: [
						{
							id: "577",
							status: "AWAITING_SHIPMENT",
							packages: [{ id: "pkg-0" }],
							line_items: [{ id: "u1" }],
						},
					],
				};
			}
			if (path?.endsWith("/shipping_services/query")) {
				return {
					shipping_services: [{ id: "svc-1", name: "Ground", price: "$6.10" }],
				};
			}
			if (path === "/fulfillment/202309/packages") {
				return { package_id: "pkg-2" };
			}
			return undefined;
		});

		const label = await tiktokBuyLabel("577", parcel, "svc-1");

		expect(label).toMatchObject({ packageId: "pkg-2", recovered: false });
	});

	test("buys when the order has no package yet", async () => {
		vi.mocked(tiktokApi).mockImplementation(async (...args) => {
			const [path] = args;
			if (path === "/order/202309/orders") {
				return {
					orders: [
						{
							id: "577",
							status: "AWAITING_SHIPMENT",
							line_items: [{ id: "u1" }],
						},
					],
				};
			}
			if (path?.endsWith("/shipping_services/query")) {
				return {
					shipping_services: [{ id: "svc-1", name: "Ground", price: "$6.10" }],
				};
			}
			if (path === "/fulfillment/202309/packages") {
				return {
					package_id: "pkg-2",
					shipping_service_info: { price: "$6.25" },
				};
			}
			return undefined;
		});

		const label = await tiktokBuyLabel("577", parcel, "svc-1");

		expect(label).toMatchObject({
			packageId: "pkg-2",
			recovered: false,
			rate: { cost: 6.25 },
		});
	});
});

describe("labelPrice", () => {
	test("reads TikTok's dollar strings", () => {
		expect(labelPrice("$7.69")).toBe(7.69);
		expect(labelPrice("$1,204.50")).toBe(1204.5);
		expect(labelPrice("5")).toBe(5);
	});

	test("refuses a price it can't read instead of calling it free", () => {
		expect(() => labelPrice("")).toThrow();
		expect(() => labelPrice("USD seven")).toThrow();
	});
});
