import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readWebhook } from "./webhooks";

const env = {
	SHOPIFY_WEBHOOK_SECRET: "shopify-secret",
	TIKTOK_CLIENT_KEY: "app-key",
	TIKTOK_CLIENT_SECRET: "tiktok-secret",
};

const shopifySignature = (body: string, secret = env.SHOPIFY_WEBHOOK_SECRET) =>
	createHmac("sha256", secret).update(body).digest("base64");

const tiktokSignature = (body: string) =>
	createHmac("sha256", env.TIKTOK_CLIENT_SECRET)
		.update(env.TIKTOK_CLIENT_KEY + body)
		.digest("hex");

describe("readWebhook", () => {
	it("finds the order in a signed Shopify webhook", () => {
		const body = JSON.stringify({
			id: 5536,
			admin_graphql_api_id: "gid://shopify/Order/5536",
		});
		const headers = new Headers({
			"x-shopify-hmac-sha256": shopifySignature(body),
		});
		expect(readWebhook("shopify", headers, body, env)).toEqual({
			orderId: "gid://shopify/Order/5536",
		});
	});

	it("refuses a Shopify webhook signed with another secret or altered", () => {
		const body = JSON.stringify({
			admin_graphql_api_id: "gid://shopify/Order/1",
		});
		const wrongSecret = new Headers({
			"x-shopify-hmac-sha256": shopifySignature(body, "other"),
		});
		expect(readWebhook("shopify", wrongSecret, body, env)).toMatchObject({
			status: 401,
		});
		const signed = new Headers({
			"x-shopify-hmac-sha256": shopifySignature(body),
		});
		expect(readWebhook("shopify", signed, `${body} `, env)).toMatchObject({
			status: 401,
		});
		expect(readWebhook("shopify", new Headers(), body, env)).toMatchObject({
			status: 401,
		});
	});

	it("refuses everything when the secret isn't set", () => {
		const body = "{}";
		const headers = new Headers({
			"x-shopify-hmac-sha256": shopifySignature(body, ""),
		});
		expect(readWebhook("shopify", headers, body, {})).toMatchObject({
			status: 401,
		});
	});

	it("finds the order in a signed TikTok order status change", () => {
		const body = JSON.stringify({
			type: 1,
			tts_notification_id: "7327",
			shop_id: "7494",
			timestamp: 1_760_000_000,
			data: {
				order_id: "576461413038785752",
				order_status: "AWAITING_SHIPMENT",
			},
		});
		const headers = new Headers({ authorization: tiktokSignature(body) });
		expect(readWebhook("tiktok", headers, body, env)).toEqual({
			orderId: "576461413038785752",
		});
	});

	it("ignores signed TikTok events that aren't about an order", () => {
		const body = JSON.stringify({ type: 5, data: { product_id: "1" } });
		const headers = new Headers({ authorization: tiktokSignature(body) });
		expect(readWebhook("tiktok", headers, body, env)).toHaveProperty("ignored");
	});

	it("refuses a TikTok webhook signed the way API requests are", () => {
		const body = JSON.stringify({ data: { order_id: "1" } });
		const headers = new Headers({
			authorization: createHmac("sha256", env.TIKTOK_CLIENT_SECRET)
				.update(body)
				.digest("hex"),
		});
		expect(readWebhook("tiktok", headers, body, env)).toMatchObject({
			status: 401,
		});
	});
});
