import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Reads a marketplace's own figures for this month (?month=current) or last
// (?month=previous) (src/reports/statements/refresh.ts), for the sales
// report. Called by Vercel Cron every four hours, signed like the other
// crons. One month a call, and apart from the cost pass, since Amazon's month
// takes a minute or more to read.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/statements/$channel")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to read statements", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const [
					{ isSyncedChannel },
					{ channelEnv, missingEnv },
					{ getDb },
					{ recentPeriod, refreshStatement },
				] = await Promise.all([
					import("#/channels/sync"),
					import("#/diagnostics/checks"),
					import("#/db/client"),
					import("#/reports/statements/refresh"),
				]);
				const channel = params.channel;
				if (!isSyncedChannel(channel))
					return new Response("Not a synced channel", { status: 404 });
				const missing = missingEnv(channelEnv[channel]);
				if (missing.length > 0)
					return Response.json({ skipped: `set ${missing.join(", ")}` });
				const month = new URL(request.url).searchParams.get("month");
				if (month !== "current" && month !== "previous")
					return new Response("Say ?month=current or ?month=previous", {
						status: 400,
					});
				// Failures are kept on marketplace_statements for the Reports tab.
				return Response.json(
					await refreshStatement(getDb(), channel, recentPeriod(month)),
				);
			},
		},
	},
});
