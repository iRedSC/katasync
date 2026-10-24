import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Sends again any tracking a marketplace refused whose retry is due
// (src/shipping/retry.ts). Called every four hours by Vercel Cron with the
// sync crons, as a sweep: retries are mostly made by the request that was
// refused (followUpTracking) and by the open orders page. Also asks Shippo
// where the packages buyers are sending back are (src/orders/return-tracking.ts).

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
				const [{ retryDueTracking }, { refreshReturnTracking }, { getDb }] =
					await Promise.all([
						import("#/shipping/retry"),
						import("#/orders/return-tracking"),
						import("#/db/client"),
					]);
				const db = getDb();
				// Each on its own, so Shippo being down never stops the retries.
				const [sent, returns] = await Promise.all([
					retryDueTracking(db),
					refreshReturnTracking(db).catch((e: unknown) => ({
						error: e instanceof Error ? e.message : String(e),
					})),
				]);
				return Response.json({ ...sent, returns });
			},
		},
	},
});
