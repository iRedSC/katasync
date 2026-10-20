import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Every five minutes (vercel.json), asks Amazon or eBay, which send katasync
// no order webhooks, whether any order we ship came in or changed lately. Only
// a yes wakes the database, for a sync pass that takes the stock and pushes it
// to every channel (src/stock-push/on-change.ts). A quiet stretch costs no
// database time; the four-hourly pass still catches anything this misses.
// Signed with `Authorization: Bearer $CRON_SECRET` like the other crons.

// Longer than the cron's interval, so a late run doesn't leave a gap.
const LOOK_BACK_MS = 7 * 60 * 1000;

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/orders/$channel")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to run syncs", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const channel = params.channel;
				if (channel !== "amazon" && channel !== "ebay")
					return new Response("This channel has webhooks", { status: 404 });
				const [{ channelEnv, missingEnv }, { hasNewOrders }] =
					await Promise.all([
						import("#/diagnostics/checks"),
						import("#/channels/new-orders"),
					]);
				const missing = missingEnv(channelEnv[channel]);
				if (missing.length > 0)
					return Response.json({ skipped: `set ${missing.join(", ")}` });
				if (!(await hasNewOrders(channel, new Date(Date.now() - LOOK_BACK_MS))))
					return Response.json({ quiet: true });
				const [{ syncPassAlone }, { getDb }] = await Promise.all([
					import("#/channels/sync"),
					import("#/db/client"),
				]);
				const result = await syncPassAlone(getDb(), channel, {
					listings: false,
				});
				if (!result)
					return Response.json({
						skipped: "another pass or webhook held the channel for 30s",
					});
				return Response.json({
					store: result.store,
					orders: result.orders,
					problems: result.problems.length,
				});
			},
		},
	},
});
