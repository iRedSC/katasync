import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

// Every five minutes (vercel.json), asks Microsoft 365 whether a supplier
// emailed the purchasing inbox lately, and whether a marketplace emailed the
// marketplaces one (src/inbox/market-mail.ts), each on its own so one
// mailbox failing never stops the other. Only a yes wakes the database, to file
// the email on its PO (src/purchasing/inbox). With ?sweep=1, every four hours
// alongside the sync crons (the database is awake then anyway), it looks back
// three days for anything a run missed and asks Shippo about packages still
// on their way. Signed with `Authorization: Bearer $CRON_SECRET`.

// Longer than the cron's interval, so a late run doesn't leave a gap.
const LOOK_BACK_MS = 7 * 60 * 1000;
const SWEEP_LOOK_BACK_MS = 3 * 86_400_000;

function fromVercel(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false;
	const sent = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${secret}`);
	return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export const Route = createFileRoute("/api/cron/inbox")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!process.env.CRON_SECRET)
					return new Response("Set CRON_SECRET to read the inbox", {
						status: 500,
					});
				if (!fromVercel(request))
					return new Response("Not from Vercel Cron", { status: 401 });
				const sweep = new URL(request.url).searchParams.has("sweep");
				const db = async () => (await import("#/db/client")).getDb();
				const [purchasing, marketplaces] = await Promise.all([
					readPurchasing(sweep).catch((e: unknown) => ({
						error: e instanceof Error ? e.message : String(e),
					})),
					(async () => {
						const { readMarketMail } = await import("#/inbox/market-mail");
						const getDb = await db();
						return readMarketMail({
							since: new Date(Date.now() - LOOK_BACK_MS),
							sweep,
							db: () => getDb,
						});
					})().catch((e: unknown) => ({
						error: e instanceof Error ? e.message : String(e),
					})),
				]);
				return Response.json({ purchasing, marketplaces });
			},
		},
	},
});

async function readPurchasing(sweep: boolean) {
	const [{ INBOX_ENV, messagesSince }, { missingEnv }] = await Promise.all([
		import("#/purchasing/inbox/graph"),
		import("#/diagnostics/checks"),
	]);
	const missing = missingEnv(INBOX_ENV);
	if (missing.length > 0) return { skipped: `set ${missing.join(", ")}` };
	const messages = await messagesSince(
		new Date(Date.now() - (sweep ? SWEEP_LOOK_BACK_MS : LOOK_BACK_MS)),
	);
	if (messages.length === 0 && !sweep) return { quiet: true };
	const [{ ingest }, { refreshTracking }, { getDb }] = await Promise.all([
		import("#/purchasing/inbox/ingest"),
		import("#/purchasing/tracking"),
		import("#/db/client"),
	]);
	const db = getDb();
	const result = await ingest(db, messages, undefined, { retrack: sweep });
	return sweep ? { ...result, tracking: await refreshTracking(db) } : result;
}
