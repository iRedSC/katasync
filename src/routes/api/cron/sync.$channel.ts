import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// One sync pass of a channel, called by Vercel Cron every four hours
// (vercel.json). Every cron runs at the same minute so the database wakes once
// and can scale to zero between runs; a cron every few minutes kept it awake
// around the clock. (Amazon and eBay are also asked every five minutes, without
// the database, whether anything sold: src/routes/api/cron/orders.$channel.ts.) While the orders page is open it syncs more often itself
// (syncChannels in src/server/sync.ts). `?listings=1` also refreshes the
// channel's listings. Vercel
// signs each call with `Authorization: Bearer $CRON_SECRET`; anything else is
// refused. Skips if the channel stays locked for 30 seconds, by a pass still
// running from the last call or a webhook.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/sync/$channel")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to run syncs", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const [
					{ isSyncedChannel, syncPassAlone },
					{ channelEnv, missingEnv },
					{ getDb },
				] = await Promise.all([
					import("#/channels/sync"),
					import("#/diagnostics/checks"),
					import("#/db/client"),
				]);
				const channel = params.channel;
				if (!isSyncedChannel(channel))
					return new Response("Not a synced channel", { status: 404 });
				const missing = missingEnv(channelEnv[channel]);
				// Not connected yet; Diagnostics says so. Nothing to retry.
				if (missing.length > 0)
					return Response.json({ skipped: `set ${missing.join(", ")}` });
				const listings = new URL(request.url).searchParams.has("listings");
				const result = await syncPassAlone(getDb(), channel, { listings });
				if (!result)
					return Response.json({
						skipped: "another pass or webhook held the channel for 30s",
					});
				// A failed pass is recorded for Diagnostics by recordSyncRun and
				// thrown, so the cron shows as failed in Vercel too.
				return Response.json({
					store: result.store,
					orders: result.orders,
					problems: result.problems.length,
					pinned: result.pinned,
				});
			},
		},
	},
});
