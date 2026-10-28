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
			target: { kind: "order", id: "gid://shopify/Order/5536" },
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
			target: { kind: "order", id: "576461413038785752" },
		});
	});

	it("ignores signed TikTok events that aren't about an order", () => {
		const body = JSON.stringify({ type: 5, data: { product_id: "1" } });
		const headers = new Headers({ authorization: tiktokSignature(body) });
		expect(readWebhook("tiktok", headers, body, env)).toHaveProperty("ignored");
	});

	// Shapes from TikTok's webhook docs, one per case event.
	it.each<[string, object, object]>([
		[
			"cancellation status change reads the order",
			{
				type: 11,
				data: {
					order_id: "576486316948490001",
					cancel_id: "4035318504086604100",
					cancel_status: "CANCELLATION_REQUEST_PENDING",
				},
			},
			{ target: { kind: "order", id: "576486316948490001" } },
		],
		[
			"return status change reads the order's returns",
			{
				type: 12,
				data: {
					order_id: "576486316948490001",
					return_id: "4035318504086604100",
					return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
					update_time: 1627587600,
				},
			},
			{ target: { kind: "order_returns", id: "576486316948490001" } },
		],
		...[64, 65, 67].map((type): [string, object, object] => [
			`event ${type} reads its aftersales case`,
			{ type, data: { aftersales_request_id: "4035352489823474416" } },
			{ target: { kind: "aftersales", id: "4035352489823474416" } },
		]),
		[
			"an aftersales event without its case is ignored",
			{ type: 64, data: { order_id: "1" } },
			{ ignored: "aftersales event without its case" },
		],
		[
			"a return event without its order is ignored",
			{ type: 12, data: { return_id: "1" } },
			{ ignored: "return event without its order" },
		],
	])("TikTok %s", (_, event, expected) => {
		const body = JSON.stringify({ tts_notification_id: "1", ...event });
		const headers = new Headers({ authorization: tiktokSignature(body) });
		expect(readWebhook("tiktok", headers, body, env)).toEqual(expected);
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
