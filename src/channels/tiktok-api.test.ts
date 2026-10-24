import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { safeToRepeat, tiktokApi } from "./tiktok";

const SEARCH = "/product/202309/products/search";
const retryLater = JSON.stringify({
	code: 36009003,
	message: "Internal error. Retry later...",
});
const ok = JSON.stringify({ code: 0, data: { products: [] } });

// Answers TikTok's login, then hands out the given answers to API calls in
// order.
function tiktokAnswers(...answers: [number, string][]) {
	const calls: string[] = [];
	const fetch = vi.fn(async (url: string | URL) => {
		const href = String(url);
		if (href.includes("/token/refresh")) {
			return Response.json({
				code: 0,
				data: {
					access_token: "token",
					access_token_expire_in: Date.now() / 1000 + 86_400,
					refresh_token: "refresh",
					refresh_token_expire_in: Date.now() / 1000 + 365 * 86_400,
				},
			});
		}
		calls.push(new URL(href).pathname);
		const [status, body] = answers.shift() ?? [599, "no answer left"];
		return new Response(body, { status });
	});
	vi.stubGlobal("fetch", fetch);
	return calls;
}

// Runs the call to its end, skipping its waits.
async function settled<T>(call: Promise<T>) {
	const result = call.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	await vi.runAllTimersAsync();
	return result;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("TIKTOK_CLIENT_KEY", "key");
	vi.stubEnv("TIKTOK_CLIENT_SECRET", "secret");
	vi.stubEnv("TIKTOK_REFRESH_TOKEN", "refresh");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("tiktokApi on TikTok's transient failures", () => {
	test("a 500 then a success is one success", async () => {
		const calls = tiktokAnswers([500, retryLater], [200, ok]);
		const result = await settled(tiktokApi(SEARCH, {}, { page_size: 50 }));
		expect(result).toEqual({ value: { products: [] } });
		expect(calls).toEqual([SEARCH, SEARCH]);
	});

	test("a retry-later code on a 200 is asked again too", async () => {
		const calls = tiktokAnswers([200, retryLater], [200, ok]);
		const result = await settled(tiktokApi(SEARCH, {}, { page_size: 50 }));
		expect(result).toEqual({ value: { products: [] } });
		expect(calls).toHaveLength(2);
	});

	test("three failures surface the error as before", async () => {
		const calls = tiktokAnswers(
			[500, retryLater],
			[502, "Bad gateway"],
			[500, retryLater],
		);
		const result = await settled(tiktokApi(SEARCH, {}, { page_size: 50 }));
		expect(result).toEqual({
			error: new Error(`TikTok answered 500 on ${SEARCH}: ${retryLater}`),
		});
		expect(calls).toHaveLength(3);
	});

	test("a 4xx is not asked again", async () => {
		const calls = tiktokAnswers([400, "Bad request"], [200, ok]);
		const result = await settled(tiktokApi(SEARCH, {}, { page_size: 50 }));
		expect(result).toEqual({
			error: new Error(`TikTok answered 400 on ${SEARCH}: Bad request`),
		});
		expect(calls).toHaveLength(1);
	});

	test("buying a label is never sent twice", async () => {
		const calls = tiktokAnswers([500, retryLater], [200, ok]);
		const result = await settled(
			tiktokApi("/fulfillment/202309/packages", {}, { order_id: "577" }),
		);
		expect(result).toHaveProperty("error");
		expect(calls).toHaveLength(1);
	});
});

test("only reads are safe to repeat, never absolute inventory replacements", () => {
	expect(safeToRepeat("GET", "/fulfillment/202309/packages/1")).toBe(true);
	expect(safeToRepeat("POST", "/order/202309/orders/search")).toBe(true);
	expect(
		safeToRepeat(
			"POST",
			"/fulfillment/202309/orders/1/shipping_services/query",
		),
	).toBe(true);
	expect(
		safeToRepeat("POST", "/product/202309/products/1/inventory/update"),
	).toBe(false);
	expect(safeToRepeat("POST", "/fulfillment/202309/packages")).toBe(false);
	expect(safeToRepeat("POST", "/fulfillment/202309/packages/1/ship")).toBe(
		false,
	);
});
