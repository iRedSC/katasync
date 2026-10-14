import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { storefrontTrackingUrl, trackingSignature } from "./tracking-link";

afterEach(() => vi.unstubAllEnvs());

test("signs like the storefront, matching Node's HMAC", async () => {
	const signature = await trackingSignature("test-secret", "5551234");
	expect(signature).toBe(
		createHmac("sha256", "test-secret")
			.update("track:5551234")
			.digest("base64url"),
	);
	expect(signature).toBe("2AuVQovS54CZLV9KTVfVVHrjctJtzEr43nsxjeKzo_8");
});

describe("storefrontTrackingUrl", () => {
	test("links the order number with its signature", async () => {
		vi.stubEnv("TRACKING_LINK_SECRET", "test-secret");
		vi.stubEnv("STOREFRONT_ORIGIN", "https://eastcoastdrywall.com");
		expect(await storefrontTrackingUrl("gid://shopify/Order/5551234")).toBe(
			"https://eastcoastdrywall.com/track/5551234/2AuVQovS54CZLV9KTVfVVHrjctJtzEr43nsxjeKzo_8",
		);
	});

	test.each([
		["no secret", "", "https://shop.example", "gid://shopify/Order/1"],
		["no origin", "s", "", "gid://shopify/Order/1"],
		[
			"an origin that isn't a URL",
			"s",
			"shop.example",
			"gid://shopify/Order/1",
		],
		["an order id that isn't Shopify's", "s", "https://shop.example", "12-34"],
	])("none with %s, and a warning", async (_, secret, origin, id) => {
		vi.stubEnv("TRACKING_LINK_SECRET", secret);
		vi.stubEnv("STOREFRONT_ORIGIN", origin);
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await storefrontTrackingUrl(id)).toBeNull();
		expect(warned).toHaveBeenCalledOnce();
		warned.mockRestore();
	});
});
