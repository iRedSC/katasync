import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// One returns pass of a channel (src/channels/returns-pass.ts), every 15
// minutes (vercel.json), so a buyer's return or refund request shows within
// minutes rather than at the next four-hourly sync. The messages and inbox
// crons keep the database awake anyway. Skips at once if the channel's last
// returns pass is still running. Signed with `Authorization: Bearer
// $CRON_SECRET` like the other crons.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/returns/$channel")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to run returns passes", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const [
					{ isSyncedChannel, returnsPassAlone },
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
				if (missing.length > 0)
					return Response.json({ skipped: `set ${missing.join(", ")}` });
				const outcome = await returnsPassAlone(getDb(), channel);
				if (!outcome)
					return Response.json({
						skipped: "the last returns pass is still running",
					});
				// Recorded on the returns feed for Diagnostics; a failure fails
				// the cron too, so it shows in Vercel.
				return Response.json(outcome, {
					status: outcome.kind === "failed" ? 502 : 200,
				});
			},
		},
	},
});
