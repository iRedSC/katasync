import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";

// Order webhooks from Shopify and TikTok Shop. They only say which order
// changed; the order itself is then read from the channel's API, the same way
// a sync pass reads it. The crons keep running, so a webhook that never
// arrives costs a few minutes, not an order.
//
// Shopify signs with SHOPIFY_WEBHOOK_SECRET, the client secret of the app
// whose token is SHOPIFY_ADMIN_TOKEN. TikTok signs with the app secret.

export type WebhookChannel = "shopify" | "tiktok";

export const webhookEnv = {
	shopify: ["SHOPIFY_WEBHOOK_SECRET"],
	tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
} as const satisfies Record<WebhookChannel, readonly string[]>;

function sameText(a: string, b: string) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

// Shopify: base64 HMAC-SHA256 of the raw body, in X-Shopify-Hmac-Sha256.
export function shopifySigned(headers: Headers, body: string, secret: string) {
	const expected = createHmac("sha256", secret).update(body).digest("base64");
	return sameText(headers.get("x-shopify-hmac-sha256") ?? "", expected);
}

// TikTok: hex HMAC-SHA256 of the app key followed by the raw body, in
// Authorization. Not the scheme its API requests use (signRequest).
export function tiktokSigned(
	headers: Headers,
	body: string,
	appKey: string,
	secret: string,
) {
	const expected = createHmac("sha256", secret)
		.update(appKey + body)
		.digest("hex");
	return sameText(
		(headers.get("authorization") ?? "").trim().toLowerCase(),
		expected,
	);
}

const shopifyOrder = type({ admin_graphql_api_id: "string" });
// Order status changes, cancellations, address changes, and so on all carry
// the order id. Other events (product, return) don't, and are ignored.
const tiktokEvent = type({ "data?": { "order_id?": "string" } });

export type WebhookResult =
	| { orderId: string }
	| { ignored: string }
	| { refused: string; status: 401 | 400 };

// Checks a webhook's signature and finds the order it's about.
export function readWebhook(
	channel: WebhookChannel,
	headers: Headers,
	body: string,
	env: Record<string, string | undefined> = process.env,
): WebhookResult {
	const { SHOPIFY_WEBHOOK_SECRET, TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET } =
		env;
	// Anyone can sign with an empty secret.
	const signed =
		channel === "shopify"
			? Boolean(SHOPIFY_WEBHOOK_SECRET) &&
				shopifySigned(headers, body, SHOPIFY_WEBHOOK_SECRET ?? "")
			: Boolean(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET) &&
				tiktokSigned(
					headers,
					body,
					TIKTOK_CLIENT_KEY ?? "",
					TIKTOK_CLIENT_SECRET ?? "",
				);
	if (!signed) return { refused: "Bad signature", status: 401 };
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return { refused: "Not JSON", status: 400 };
	}
	if (channel === "shopify") {
		const order = shopifyOrder(json);
		if (order instanceof type.errors)
			return { ignored: "not an order webhook" };
		return { orderId: order.admin_graphql_api_id };
	}
	const event = tiktokEvent(json);
	const orderId =
		event instanceof type.errors ? undefined : event.data?.order_id;
	return orderId ? { orderId } : { ignored: "not about an order" };
}
