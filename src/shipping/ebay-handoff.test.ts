import { beforeEach, describe, expect, test, vi } from "vitest";
import { ebayShip } from "./ebay-handoff";
import { ContentsChanged, Held } from "./packed";

type Line = { lineItemId: string; quantity: number; refunds?: unknown[] };
type Shipment = {
	fulfillmentId: string;
	shipmentTrackingNumber?: string;
	lineItems?: { lineItemId: string; quantity: number }[];
};

function ebay(
	lines: Line[],
	shipments: Shipment[] = [],
	cancelState = "NONE_REQUESTED",
) {
	const posts: unknown[] = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		const json = (body: unknown, headers: Record<string, string> = {}) =>
			new Response(JSON.stringify(body), { status: 200, headers });
		if (url.endsWith("/identity/v1/oauth2/token")) {
			return json({ access_token: "t", expires_in: 7200 });
		}
		if (url.endsWith("/shipping_fulfillment") && init?.method === "POST") {
			posts.push(JSON.parse(String(init.body)));
			return new Response(null, {
				status: 201,
				headers: { location: `${url}/F-new` },
			});
		}
		if (url.endsWith("/shipping_fulfillment")) {
			return json({ fulfillments: shipments });
		}
		return json({
			cancelStatus: { cancelState },
			lineItems: lines.map((l) => ({ title: l.lineItemId, ...l })),
		});
	});
	return posts;
}

const shipment = {
	carrier: "USPS",
	trackingNumber: "9400",
	shippedAt: new Date("2026-10-23T12:00:00Z"),
};
const packed = new Map([["L1", 2]]);

beforeEach(() => {
	vi.stubEnv("EBAY_CLIENT_ID", "id");
	vi.stubEnv("EBAY_CLIENT_SECRET", "secret");
	vi.stubEnv("EBAY_REFRESH_TOKEN", "refresh");
});

describe("ebayShip", () => {
	test("sends exactly the packed quantities when they're what eBay has left", async () => {
		const posts = ebay([{ lineItemId: "L1", quantity: 2 }]);
		expect(await ebayShip("o", packed, shipment)).toEqual({
			fulfillmentId: "F-new",
			remaining: 0,
		});
		expect(posts).toEqual([
			expect.objectContaining({
				lineItems: [{ lineItemId: "L1", quantity: 2 }],
				trackingNumber: "9400",
			}),
		]);
	});

	test("what eBay already shipped another way comes off what's left", async () => {
		const posts = ebay(
			[{ lineItemId: "L1", quantity: 3 }],
			[
				{
					fulfillmentId: "F0",
					shipmentTrackingNumber: "1Z",
					lineItems: [{ lineItemId: "L1", quantity: 1 }],
				},
			],
		);
		await ebayShip("o", packed, shipment);
		expect(posts).toHaveLength(1);
	});

	test("more or other lines on eBay than packed sends nothing", async () => {
		const posts = ebay([
			{ lineItemId: "L1", quantity: 2 },
			{ lineItemId: "L2", quantity: 1 },
		]);
		await expect(ebayShip("o", packed, shipment)).rejects.toBeInstanceOf(
			ContentsChanged,
		);
		expect(posts).toEqual([]);
	});

	test("an earlier shipment with this tracking is taken only if it holds exactly the box", async () => {
		ebay(
			[{ lineItemId: "L1", quantity: 2 }],
			[
				{
					fulfillmentId: "F1",
					shipmentTrackingNumber: "9400",
					lineItems: [{ lineItemId: "L1", quantity: 2 }],
				},
			],
		);
		expect(await ebayShip("o", packed, shipment)).toEqual({
			fulfillmentId: "F1",
			remaining: 0,
		});

		const posts = ebay(
			[{ lineItemId: "L1", quantity: 3 }],
			[
				{
					fulfillmentId: "F1",
					shipmentTrackingNumber: "9400",
					lineItems: [{ lineItemId: "L1", quantity: 1 }],
				},
			],
		);
		await expect(ebayShip("o", packed, shipment)).rejects.toThrow(
			"other items",
		);
		expect(posts).toEqual([]);
	});

	test("a cancellation, a refund, or an unreadable shipment is held", async () => {
		const cases = [
			() => ebay([{ lineItemId: "L1", quantity: 2 }], [], "CANCEL_REQUESTED"),
			() => ebay([{ lineItemId: "L1", quantity: 2, refunds: [{}] }]),
			() =>
				ebay([{ lineItemId: "L1", quantity: 3 }], [{ fulfillmentId: "F0" }]),
		];
		for (const setUp of cases) {
			const posts = setUp();
			await expect(ebayShip("o", packed, shipment)).rejects.toBeInstanceOf(
				Held,
			);
			expect(posts).toEqual([]);
		}
	});
});
