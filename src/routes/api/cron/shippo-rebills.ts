import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Imports what Shippo re-billed on katasync's labels
// (src/shipping/shippo-adjustments.ts). Called daily by Vercel Cron: Shippo's
// invoice report refreshes through the day, and re-bills come weeks late.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/shippo-rebills")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to import Shippo re-bills", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				if (!process.env.SHIPPO_API_KEY)
					return Response.json({ skipped: "set SHIPPO_API_KEY" });
				const [{ importShippoRebills }, { getDb }] = await Promise.all([
					import("#/shipping/shippo-adjustments"),
					import("#/db/client"),
				]);
				return Response.json(await importShippoRebills(getDb()));
			},
		},
	},
});
