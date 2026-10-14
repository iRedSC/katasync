import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";

// Order webhooks (src/channels/webhooks.ts) at /api/webhooks/shopify and
// /api/webhooks/tiktok. Answers as soon as the signature checks out, since
// Shopify gives up after 5 seconds and TikTok after 3, then reads the order
// in the background, after any running sync pass of that channel finishes.

export const Route = createFileRoute("/api/webhooks/$channel")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const channel = params.channel;
				if (channel !== "shopify" && channel !== "tiktok")
					return new Response("No webhooks for this channel", { status: 404 });
				const [{ readWebhook, webhookEnv }, { missingEnv }] = await Promise.all(
					[import("#/channels/webhooks"), import("#/diagnostics/checks")],
				);
				const missing = missingEnv(webhookEnv[channel]);
				if (missing.length > 0)
					return new Response(`Set ${missing.join(", ")}`, { status: 500 });
				const result = readWebhook(
					channel,
					request.headers,
					await request.text(),
				);
				if ("refused" in result)
					return new Response(result.refused, { status: result.status });
				if ("ignored" in result) return Response.json(result);
				waitUntil(
					(async () => {
						const [{ ingestWebhookOrder }, { getDb }] = await Promise.all([
							import("#/channels/sync"),
							import("#/db/client"),
						]);
						await ingestWebhookOrder(getDb(), channel, result.orderId);
					})().catch((error) =>
						console.error(`${channel} webhook for ${result.orderId}:`, error),
					),
				);
				return Response.json({ accepted: result.orderId });
			},
		},
	},
});
