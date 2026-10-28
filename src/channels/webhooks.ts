import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";
import type { webhookTarget } from "#/db/webhook-schema";

// Webhooks from Shopify and TikTok Shop. They only say what changed: an
// order, or on TikTok also a return or aftersales case. That is then read
// from the channel's API, the same way a pass reads it. The crons keep
// running, so a webhook that never arrives costs a few minutes, not an order.
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

// What to read again. order_returns: the returns on a TikTok order, since
// its return status change names the order and SKU return, and only the
// order can be searched by. aftersales: one TikTok aftersales case.
type TargetKind = (typeof webhookTarget.enumValues)[number];
export type WebhookTarget = {
	[K in TargetKind]: { kind: K; id: string };
}[TargetKind];

const shopifyOrder = type({ admin_graphql_api_id: "string" });
const tiktokEvent = type({
	"type?": "number.integer",
	"data?": {
		"order_id?": "string",
		"aftersales_request_id?": "string",
	},
});

// TikTok's event types about a case: 12 return status change, 64
// aftersales request status update, 65 RMA status update, 67 refund
// success. A cancellation (11), like order status changes, address changes
// and so on, carries the order id and reads the order again. Other events
// (product, message) don't, and are ignored.
const RETURN_STATUS_CHANGE = 12;
const AFTERSALES_EVENTS = new Set([64, 65, 67]);

export function tiktokTarget(
	event: typeof tiktokEvent.infer,
): WebhookTarget | { ignored: string } {
	const { order_id: orderId, aftersales_request_id: caseId } = event.data ?? {};
	if (event.type === RETURN_STATUS_CHANGE)
		return orderId
			? { kind: "order_returns", id: orderId }
			: { ignored: "return event without its order" };
	if (event.type !== undefined && AFTERSALES_EVENTS.has(event.type))
		return caseId
			? { kind: "aftersales", id: caseId }
			: { ignored: "aftersales event without its case" };
	return orderId
		? { kind: "order", id: orderId }
		: { ignored: "not about an order" };
}

export type WebhookResult =
	| { target: WebhookTarget }
	| { ignored: string }
	| { refused: string; status: 401 | 400 };

// Checks a webhook's signature and finds what it's about.
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
		return { target: { kind: "order", id: order.admin_graphql_api_id } };
	}
	const event = tiktokEvent(json);
	if (event instanceof type.errors) return { ignored: "not about an order" };
	const target = tiktokTarget(event);
	return "ignored" in target ? target : { target };
}
