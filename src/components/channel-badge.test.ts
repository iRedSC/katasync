import { expect, test } from "vitest";
import { brandOf } from "./channel-badge";

test("direct marketplace orders wear their marketplace", () => {
	expect(brandOf("amazon", "Amazon FBA")).toBe("amazon");
	expect(brandOf("ebay", null)).toBe("ebay");
	expect(brandOf("tiktok", null)).toBe("tiktok");
});

test("Shopify's own storefronts wear Shopify", () => {
	expect(brandOf("shopify", "Online Store")).toBe("shopify");
	expect(brandOf("shopify", "Point of Sale")).toBe("shopify");
	expect(brandOf("shopify", null)).toBe("shopify");
	expect(brandOf("shopify", "")).toBe("shopify");
});

test("a TikTok sale relayed through Shopify wears TikTok", () => {
	expect(brandOf("shopify", "TikTok")).toBe("tiktok");
});

test("a sale on Shopify's Shop app wears Shop", () => {
	expect(brandOf("shopify", "Shop")).toBe("shop");
});

test("other Shopify sources get the plain chip", () => {
	expect(brandOf("shopify", "Draft Orders")).toBeNull();
	expect(brandOf("shopify", "web")).toBeNull();
	expect(brandOf("shopify", "Amazon Multi-Channel Fulfillment")).toBeNull();
});
