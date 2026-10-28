import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";

// Webhooks (src/channels/webhooks.ts) at /api/webhooks/shopify and
// /api/webhooks/tiktok. Stores what changed (an order, or a TikTok case) in
// the inbox (src/channels/webhook-inbox.ts) before answering, so an answer
// means it survives; a failed store answers 503 and the sender retries. Then
// reads it in the background. Whatever that misses, the retry cron drains.

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
				const body = await request.text();
				const result = readWebhook(channel, request.headers, body);
				if ("refused" in result)
					return new Response(result.refused, { status: result.status });
				if ("ignored" in result) return Response.json(result);
				const [{ acceptWebhook, drainDue, ingestWith }, { getDb }] =
					await Promise.all([
						import("#/channels/webhook-inbox"),
						import("#/db/client"),
					]);
				const db = getDb();
				try {
					await acceptWebhook(db, channel, result.target, body);
				} catch (error) {
					console.error(
						`${channel} webhook for ${result.target.kind} ${result.target.id}:`,
						error,
					);
					return new Response("Not saved, send again", { status: 503 });
				}
				waitUntil(
					drainDue(db, ingestWith(db)).catch((error) =>
						console.error(`${channel} webhook drain:`, error),
					),
				);
				// A new Shopify order may be a repair's draft just paid, so the
				// board moves it without waiting for someone to open it.
				if (channel === "shopify")
					waitUntil(
						import("#/repairs/draft-sync")
							.then(({ refreshDrafts }) => refreshDrafts(db))
							.catch((error) => console.error("repair drafts:", error)),
					);
				return Response.json({ accepted: result.target });
			},
		},
	},
});
