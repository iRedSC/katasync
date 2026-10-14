import { beforeEach, describe, expect, test, vi } from "vitest";
import { getRate } from "#/shipping/shippo";
import {
	shopifyQuery,
	shopifyRemoveShippoTracking,
	shopifySaveShippoTracking,
} from "./shopify";

type Call = { query: string; variables: Record<string, unknown> };

// Stands in for Shopify: answers the metafield read with `stored`, records
// what was written.
function fakeShopify(stored: string | null) {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const call = JSON.parse(String(init.body)) as Call;
		calls.push(call);
		const data = call.query.startsWith("mutation")
			? { metafieldsSet: { userErrors: [] } }
			: {
					order: {
						metafield:
							stored === null ? null : { value: stored, compareDigest: "d1" },
					},
				};
		return Response.json({ data });
	});
	const written = () => {
		const write = calls.find((c) => c.query.startsWith("mutation"));
		return write
			? (write.variables.metafields as Record<string, unknown>[])[0]
			: undefined;
	};
	return { calls, written };
}

beforeEach(() => {
	vi.stubEnv("SHOPIFY_STORE_DOMAIN", "shop.example");
	vi.stubEnv("SHOPIFY_ADMIN_TOKEN", "token");
	vi.stubEnv("SHIPPO_API_KEY", "shippo_live_x");
});

describe("the order's shippo_tracking metafield", () => {
	test("is created with the first label, only if it still doesn't exist", async () => {
		const shopify = fakeShopify(null);
		await shopifySaveShippoTracking("gid://shopify/Order/9", {
			number: "940",
			carrier: "usps",
		});
		expect(shopify.written()).toEqual({
			ownerId: "gid://shopify/Order/9",
			namespace: "katasync",
			key: "shippo_tracking",
			type: "json",
			value: '[{"number":"940","carrier":"usps"}]',
			compareDigest: null,
		});
	});

	test("keeps other labels and replaces one with the same number", async () => {
		const shopify = fakeShopify(
			'[{"number":"940","carrier":"ups"},{"number":"1Z","carrier":"ups"}]',
		);
		await shopifySaveShippoTracking("gid://shopify/Order/9", {
			number: "940",
			carrier: "usps",
		});
		expect(shopify.written()).toMatchObject({
			value:
				'[{"number":"1Z","carrier":"ups"},{"number":"940","carrier":"usps"}]',
			compareDigest: "d1",
		});
	});

	test("keeps the carrier's own link, and replaces an entry from before links were kept", async () => {
		const shopify = fakeShopify('[{"number":"940","carrier":"usps"}]');
		await shopifySaveShippoTracking("gid://shopify/Order/9", {
			number: "940",
			carrier: "usps",
			url: "https://tools.usps.com/x",
		});
		expect(shopify.written()).toMatchObject({
			value:
				'[{"number":"940","carrier":"usps","url":"https://tools.usps.com/x"}]',
		});
	});

	test("a repeat save writes nothing", async () => {
		const shopify = fakeShopify('[{"number":"940","carrier":"usps"}]');
		await shopifySaveShippoTracking("gid://shopify/Order/9", {
			number: "940",
			carrier: "usps",
		});
		expect(shopify.written()).toBeUndefined();
	});

	test("voiding takes only that label off", async () => {
		const shopify = fakeShopify(
			'[{"number":"940","carrier":"usps"},{"number":"1Z","carrier":"ups"}]',
		);
		await shopifyRemoveShippoTracking("gid://shopify/Order/9", "940");
		expect(shopify.written()).toMatchObject({
			value: '[{"number":"1Z","carrier":"ups"}]',
		});
	});

	test("a value that isn't the expected list fails instead of being overwritten", async () => {
		const shopify = fakeShopify('{"oops":true}');
		await expect(
			shopifyRemoveShippoTracking("gid://shopify/Order/9", "940"),
		).rejects.toThrow();
		expect(shopify.written()).toBeUndefined();
	});
});

describe("getRate", () => {
	test("takes the carrier token from the rate's carrier account", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return Response.json(
				url.includes("/carrier_accounts/")
					? { object_id: "acct1", carrier: "usps" }
					: {
							object_id: "rate1",
							amount: "7.08",
							provider: "USPS",
							carrier_account: "acct1",
							servicelevel: {
								name: "Ground Advantage",
								token: "usps_ground_advantage",
							},
						},
			);
		});
		expect(await getRate("rate1")).toMatchObject({
			carrier: "USPS",
			carrierToken: "usps",
		});
		expect(urls[1]).toBe("https://api.goshippo.com/carrier_accounts/acct1");
	});
});

test("a Shopify call with a timeout gives up instead of hanging", async () => {
	vi.stubGlobal(
		"fetch",
		(_url: string, init: RequestInit) =>
			new Promise((_, reject) =>
				init.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				),
			),
	);
	await expect(
		shopifyQuery("{ shop { name } }", {}, { timeoutMs: 50 }),
	).rejects.toThrow("Shopify didn't answer within 50ms");
});
