import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Reads each marketplace's account standing (src/markets/refresh.ts), so
// the sidebar flags a market at risk without anyone opening Markets.
// Called by Vercel Cron.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/standing")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to check standing", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const [{ checkStale }, { getDb }] = await Promise.all([
					import("#/markets/refresh"),
					import("#/db/client"),
				]);
				// Everything, whenever it was last read.
				return Response.json({ checked: await checkStale(getDb(), 0) });
			},
		},
	},
});
