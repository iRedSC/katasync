// Points Shopify's and TikTok's order webhooks at katasync, so new and
// changed orders arrive in seconds instead of on the next cron.
//
//   pnpm webhooks https://katasync.example.com
//                       subscribe both channels (safe to repeat)
//   pnpm webhooks       show what each channel sends where
//
// A shop has one TikTok order-status URL per app. If it already points somewhere else, this stops
// and says where; add --replace to take it over.
import { parseArgs } from "node:util";
import { type } from "arktype";
import { shopifyQuery } from "#/channels/shopify";
import { shopCipher, tiktokApi } from "#/channels/tiktok";

try {
	process.loadEnvFile(".env.local");
} catch {
	// No .env.local; rely on the real environment.
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { replace: { type: "boolean", default: false } },
});
const base = positionals[0]?.replace(/\/$/, "");
if (base && !base.startsWith("https://"))
	throw new Error("Give the https:// address katasync is served at");

// Creation and every later change, cancellations included.
const SHOPIFY_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED"];

const shopifySubscriptions = type({
	webhookSubscriptions: {
		nodes: type({
			topic: "string",
			endpoint: type({ "callbackUrl?": "string" }),
		}).array(),
	},
});

async function shopify() {
	const { webhookSubscriptions } = shopifySubscriptions.assert(
		await shopifyQuery(
			"{ webhookSubscriptions(first: 100) { nodes { topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } } }",
			{},
		),
	);
	for (const s of webhookSubscriptions.nodes)
		console.log(
			`shopify ${s.topic} -> ${s.endpoint.callbackUrl ?? "(not https)"}`,
		);
	if (!base) return;
	const url = `${base}/api/webhooks/shopify`;
	for (const topic of SHOPIFY_TOPICS) {
		if (
			webhookSubscriptions.nodes.some(
				(s) => s.topic === topic && s.endpoint.callbackUrl === url,
			)
		)
			continue;
		const { webhookSubscriptionCreate } = type({
			webhookSubscriptionCreate: {
				userErrors: type({ message: "string" }).array(),
			},
		}).assert(
			await shopifyQuery(
				"mutation($topic: WebhookSubscriptionTopic!, $url: URL!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) { userErrors { message } } }",
				{ topic, url },
			),
		);
		if (webhookSubscriptionCreate.userErrors.length > 0)
			throw new Error(
				`Shopify refused ${topic}: ${webhookSubscriptionCreate.userErrors.map((e) => e.message).join("; ")}`,
			);
		console.log(`shopify ${topic} -> ${url} (added)`);
	}
}

const ORDER_STATUS = "ORDER_STATUS_CHANGE";

async function tiktok() {
	const cipher = await shopCipher();
	const { webhooks } = type({
		"webhooks?": type({ event_type: "string", address: "string" }).array(),
	}).assert(await tiktokApi("/event/202309/webhooks", { shop_cipher: cipher }));
	for (const w of webhooks ?? [])
		console.log(`tiktok ${w.event_type} -> ${w.address}`);
	if (!base) return;
	const url = `${base}/api/webhooks/tiktok`;
	const current = webhooks?.find((w) => w.event_type === ORDER_STATUS);
	if (current?.address === url) return;
	if (current && !values.replace) {
		console.log(
			`tiktok ${ORDER_STATUS} already goes to ${current.address}; rerun with --replace to point it at katasync instead`,
		);
		return;
	}
	await tiktokApi(
		"/event/202309/webhooks",
		{ shop_cipher: cipher },
		{ address: url, event_type: ORDER_STATUS },
		"PUT",
	);
	console.log(`tiktok ${ORDER_STATUS} -> ${url} (set)`);
}

await shopify();
await tiktok();
