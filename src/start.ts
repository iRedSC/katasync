import { createMiddleware, createStart } from "@tanstack/react-start";
import { waitUntil } from "@vercel/functions";
import { requestOperation } from "#/audit/request-operation";
import { dropUndefined } from "#/lib/drop-undefined";

// Everything needs a signed-in device except the sign-in pages (see
// src/auth/guard.ts). The dev server skips this: passkeys are tied to the
// production address, and dev is only reachable over Tailscale.
//
// Cross-site form posts are covered by the session cookie being SameSite=Lax:
// without the cookie a request is refused.
//
// Each request then runs as whoever it was admitted as (src/audit/context.ts),
// so the audit log credits its changes to them.
const signedIn = createMiddleware().server(async ({ request, next }) => {
	const [{ admit }, { getDb }, { runAs }, { systemActor }] = await Promise.all([
		import("#/auth/guard"),
		import("#/db/client"),
		import("#/audit/context"),
		import("#/auth/actor"),
	]);
	const operation = requestOperation(request);
	if (import.meta.env.DEV)
		return runAs(systemActor("dev-server"), operation, () => next());
	const admission = await admit(request, getDb());
	if (admission.kind === "refused") return admission.response;
	const actor = admission.actor;
	const result = await (actor ? runAs(actor, operation, () => next()) : next());
	const renewed = admission.kind === "signed-in" ? admission.setCookie : null;
	if (!renewed) return result;
	// The session was renewed, so the cookie's lifetime moves with it. The
	// headers of a response from elsewhere may be read-only, so copy it.
	const headers = new Headers(result.response.headers);
	headers.append("Set-Cookie", renewed);
	return {
		...result,
		response: new Response(result.response.body, {
			status: result.response.status,
			statusText: result.response.statusText,
			headers,
		}),
	};
});

// Anything done in the app or over MCP that moves stock (a count, a receipt, a
// return) reaches the channels right after the response, not at the next sync
// pass. Webhooks and crons push for themselves. A request that moved nothing
// costs one indexed query.
const pushesStock = createMiddleware().server(async ({ request, next }) => {
	const path = new URL(request.url).pathname;
	if (
		request.method !== "POST" ||
		path.startsWith("/api/webhooks/") ||
		path.startsWith("/api/cron/")
	)
		return next();
	const started = new Date();
	const result = await next();
	waitUntil(
		(async () => {
			const [{ pushMoved }, { getDb }, { runAs }, { systemActor }] =
				await Promise.all([
					import("#/stock-push/on-change"),
					import("#/db/client"),
					import("#/audit/context"),
					import("#/auth/actor"),
				]);
			await runAs(systemActor("stock-push"), "stock-push", async () => {
				for (const p of await pushMoved(getDb(), started))
					for (const problem of p.problems) console.warn(problem);
			});
		})().catch((error) => console.error("Stock push after a request:", error)),
	);
	return result;
});

// Runs before every server function's own validator (src/lib/drop-undefined.ts).
const dropsUndefined = createMiddleware({ type: "function" }).validator(
	dropUndefined,
);

export const startInstance = createStart(() => ({
	requestMiddleware: [signedIn, pushesStock],
	functionMiddleware: [dropsUndefined],
}));
