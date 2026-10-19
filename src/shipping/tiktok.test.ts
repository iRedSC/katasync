import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("#/channels/tiktok", async (actual) => ({
	TiktokError: (await actual<typeof import("#/channels/tiktok")>()).TiktokError,
	shopCipher: async () => "cipher",
	tiktokApi: vi.fn(),
}));

import { TiktokError, tiktokApi } from "#/channels/tiktok";
import { labelPrice, tiktokBuyLabel, tiktokShipPackage } from "./tiktok";

const parcel = {
	lengthMm: 300,
	widthMm: 200,
	heightMm: 100,
	weightGrams: 600,
	hazmat: false,
};

beforeEach(() => {
	vi.mocked(tiktokApi).mockReset();
});

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

describe("tiktokShipPackage", () => {
	const docs = "/fulfillment/202309/packages/pkg-1/shipping_documents";
	const notArranged = () =>
		new TiktokError(
			21023035,
			docs,
			"Please arrange shipment before retrieving the shipping document.",
		);
	const processing = (path: string) =>
		new TiktokError(
			21001028,
			path,
			"The order is being processed. Try again later.",
		);
	// TikTok's answers to the document request, one per call, and to /ship.
	function answers(docAnswers: (Error | string)[], shipAnswers: Error[] = []) {
		vi.mocked(tiktokApi).mockImplementation(async (...args) => {
			const [path] = args;
			if (path === "/fulfillment/202309/packages/pkg-1") {
				return { package_status: "PROCESSING" };
			}
			if (path.endsWith("/ship")) {
				const next = shipAnswers.shift();
				if (next) throw next;
				return undefined;
			}
			if (path === docs) {
				const next = docAnswers.shift();
				if (next instanceof Error) throw next;
				return {
					doc_url: "https://tiktok.example/l.pdf",
					tracking_number: next,
				};
			}
			return undefined;
		});
	}

	test("waits for TikTok to arrange the shipment, then takes its tracking", async () => {
		answers([notArranged(), processing(docs), "9400TT"]);

		expect(await tiktokShipPackage("pkg-1", [0, 0, 0])).toEqual({
			id: "pkg-1",
			trackingNumber: "9400TT",
		});
		const paths = vi.mocked(tiktokApi).mock.calls.map(([path]) => path);
		expect(paths.filter((p) => p.endsWith("/ship"))).toHaveLength(1);
		expect(paths.filter((p) => p === docs)).toHaveLength(3);
	});

	test("counts as shipped without tracking when TikTok is still arranging", async () => {
		answers([notArranged(), processing(docs), notArranged()]);

		expect(await tiktokShipPackage("pkg-1", [0, 0])).toEqual({
			id: "pkg-1",
			trackingNumber: null,
		});
	});

	test("waits for TikTok to finish processing a new package before shipping it", async () => {
		const ship = "/fulfillment/202309/packages/pkg-1/ship";
		answers(["9400TT"], [processing(ship), processing(ship)]);

		expect(await tiktokShipPackage("pkg-1", [0, 0, 0])).toEqual({
			id: "pkg-1",
			trackingNumber: "9400TT",
		});
		const paths = vi.mocked(tiktokApi).mock.calls.map(([path]) => path);
		expect(paths.filter((p) => p === ship)).toHaveLength(3);
	});

	test("a package still processing after the wait fails the handoff, unshipped", async () => {
		const ship = "/fulfillment/202309/packages/pkg-1/ship";
		answers(["9400TT"], [processing(ship), processing(ship), processing(ship)]);

		await expect(tiktokShipPackage("pkg-1", [0, 0])).rejects.toThrow(
			"21001028",
		);
		const paths = vi.mocked(tiktokApi).mock.calls.map(([path]) => path);
		expect(paths).not.toContain(docs);
	});

	test("any other refusal still fails the handoff", async () => {
		answers([new TiktokError(12345, docs, "Something else")]);

		await expect(tiktokShipPackage("pkg-1", [0, 0])).rejects.toThrow(
			"Something else",
		);
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
