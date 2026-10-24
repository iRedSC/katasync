import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/webhooks")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to drain webhooks", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const [{ backlogSummary, drainDue, ingestWith }, { getDb }] =
					await Promise.all([
						import("#/channels/webhook-inbox"),
						import("#/db/client"),
					]);
				const db = getDb();
				const drained = await drainDue(db, ingestWith(db));
				return Response.json({ drained, backlog: await backlogSummary(db) });
			},
		},
	},
});
