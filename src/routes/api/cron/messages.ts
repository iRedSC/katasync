import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Every five minutes (vercel.json), reads buyers' messages in and settles
// replies still in flight (src/buyers/run.ts). With ?sweep=1, every four
// hours, eBay's are read two weeks back for anything a run missed.
// Signed with `Authorization: Bearer $CRON_SECRET`.

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/messages")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to read messages", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const sweep = new URL(request.url).searchParams.has("sweep");
				const [{ runBuyerMessages }, { getDb }] = await Promise.all([
					import("#/buyers/run"),
					import("#/db/client"),
				]);
				return Response.json(await runBuyerMessages(getDb(), { sweep }));
			},
		},
	},
});
