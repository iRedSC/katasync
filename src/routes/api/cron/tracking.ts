import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Sends again any tracking a marketplace refused whose retry is due
// (src/shipping/retry.ts). Called every minute by Vercel Cron, signed like
// the sync crons.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/tracking")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to retry tracking", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const [{ retryDueTracking }, { getDb }] = await Promise.all([
					import("#/shipping/retry"),
					import("#/db/client"),
				]);
				return Response.json(await retryDueTracking(getDb()));
			},
		},
	},
});
