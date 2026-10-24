import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("#/channels/tiktok", async (actual) => ({
	TiktokError: (await actual<typeof import("#/channels/tiktok")>()).TiktokError,
	shopCipher: async () => "cipher",
	tiktokApi: vi.fn(),
}));

import { TiktokError, tiktokApi } from "#/channels/tiktok";
import { LabelRefused } from "./label-attempt-state";
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
	const answers = (create: () => Promise<unknown>) =>
		vi.mocked(tiktokApi).mockImplementation(async (...args) => {
			const [path] = args;
			if (path?.endsWith("/shipping_services/query")) {
				return {
					shipping_services: [{ id: "svc-1", name: "Ground", price: "$6.10" }],
				};
			}
			if (path === "/fulfillment/202309/packages") return create();
			return undefined;
		});
	const call = (path: string) =>
		vi.mocked(tiktokApi).mock.calls.find(([p]) => p === path);

	test("buys a package for exactly the units given, never taking one that exists", async () => {
		answers(async () => ({
			package_id: "pkg-2",
			shipping_service_info: { price: "$6.25" },
		}));
		const label = await tiktokBuyLabel("577", parcel, "svc-1", ["u1", "u2"]);
		expect(label).toMatchObject({ packageId: "pkg-2", rate: { cost: 6.25 } });
		expect(call("/order/202309/orders")).toBeUndefined();
		expect(call("/fulfillment/202309/packages")?.[2]).toMatchObject({
			order_id: "577",
			order_line_item_ids: ["u1", "u2"],
		});
	});

	test("a service no longer offered is a refusal, with nothing bought", async () => {
		answers(async () => ({ package_id: "x" }));
		await expect(
			tiktokBuyLabel("577", parcel, "svc-gone", ["u1"]),
		).rejects.toBeInstanceOf(LabelRefused);
		expect(call("/fulfillment/202309/packages")).toBeUndefined();
	});

	test("TikTok's own error on the create is a refusal; a dropped connection isn't", async () => {
		answers(async () => {
			throw new TiktokError(1, "/fulfillment/202309/packages", "bad parcel");
		});
		await expect(
			tiktokBuyLabel("577", parcel, "svc-1", ["u1"]),
		).rejects.toBeInstanceOf(LabelRefused);
		answers(async () => {
			throw new Error("socket hang up");
		});
		const lost = tiktokBuyLabel("577", parcel, "svc-1", ["u1"]);
		await expect(lost).rejects.toThrow("socket hang up");
		await expect(lost).rejects.not.toBeInstanceOf(LabelRefused);
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
