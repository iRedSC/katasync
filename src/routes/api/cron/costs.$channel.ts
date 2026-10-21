import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// One cost pass of a channel: asks the marketplace what it charged on orders
// that are due (src/orders/cost-refresh.ts), then refreshes its payouts
// (src/payouts/refresh.ts). Called by Vercel Cron every four
// hours with the sync crons, signed like them. Skips at once if the
// last cost pass is still running.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/costs/$channel")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to run cost passes", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const [
					{ isSyncedChannel, costPassAlone },
					{ channelEnv, missingEnv },
					{ getDb },
					{ refreshPayouts },
				] = await Promise.all([
					import("#/channels/sync"),
					import("#/diagnostics/checks"),
					import("#/db/client"),
					import("#/payouts/refresh"),
				]);
				const channel = params.channel;
				if (!isSyncedChannel(channel))
					return new Response("Not a synced channel", { status: 404 });
				const missing = missingEnv(channelEnv[channel]);
				if (missing.length > 0)
					return Response.json({ skipped: `set ${missing.join(", ")}` });
				// Batches start for three minutes, so the last one ends well
				// inside Vercel's five-minute limit.
				const result = await costPassAlone(getDb(), channel, {
					keepGoingForMs: 3 * 60_000,
				});
				// A few calls, so it runs even when the cost pass was skipped. A
				// failure is kept on payout_checks for the Reports tab.
				const deposits = await refreshPayouts(getDb(), channel);
				if (!result)
					return Response.json({
						skipped: "the last cost pass is still running",
						deposits,
					});
				// Single orders that failed are kept on their checks for
				// Diagnostics; the pass itself worked.
				return Response.json({
					checked: result.checked,
					reported: result.reported,
					problems: result.problems.length,
					deposits,
				});
			},
		},
	},
});
