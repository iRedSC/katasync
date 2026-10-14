import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";

// Order webhooks (src/channels/webhooks.ts) at /api/webhooks/shopify and
// /api/webhooks/tiktok. Answers as soon as the signature checks out, since
// Shopify gives up after 5 seconds and TikTok after 3, then reads the order
// in the background. If a sync pass or another webhook holds the channel, it
// drops the order instead of waiting; the next cron pass reads it anyway.

export const Route = createFileRoute("/api/webhooks/$channel")({
	server: {
		handlers: {
			// Without it the sign-in guard, which lets every method through here,
			// would hand a signed-out GET to the app's pages.
			GET: () =>
				new Response("Method Not Allowed", {
					status: 405,
					headers: { Allow: "POST" },
				}),
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
						const done = await ingestWebhookOrder(
							getDb(),
							channel,
							result.orderId,
						);
						if (!done)
							console.log(
								`${channel} webhook for ${result.orderId}: busy, cron will pick it up`,
							);
					})().catch((error) =>
						console.error(`${channel} webhook for ${result.orderId}:`, error),
					),
				);
				return Response.json({ accepted: result.orderId });
			},
		},
	},
});
