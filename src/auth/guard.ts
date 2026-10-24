import { type Db, getDb } from "#/db/client";
import { type Actor, type SystemName, systemActor } from "./actor";
import { standingOfSession } from "./principal";
import { SESSION_COOKIE, sessionCookie } from "./sessions";

// Decides, for every request, whether it may go ahead without a session.
// Server only; src/start.ts runs it, except on the dev server.

// Reachable while signed out: the sign-in and setup pages, their API, and
// the files those pages load. /mcp checks its own OAuth token instead, and
// /api/oauth/ and /.well-known/ are how MCP clients get one (approving still
// needs a session); /api/cron/ checks the CRON_SECRET Vercel Cron sends, and
// /api/webhooks/ the channel's signature; /api/uploads/ checks the upload link's
// own token.
const PUBLIC_PATHS = new Set([
	"/mcp",
	"/login",
	"/setup",
	"/favicon.svg",
	"/logo.svg",
	"/manifest.webmanifest",
	"/receive-192.png",
	"/receive-512.png",
]);

export function isPublic(pathname: string) {
	return (
		PUBLIC_PATHS.has(pathname) ||
		pathname.startsWith("/api/auth/") ||
		pathname.startsWith("/api/oauth/") ||
		pathname.startsWith("/.well-known/") ||
		pathname.startsWith("/api/cron/") ||
		pathname.startsWith("/api/webhooks/") ||
		pathname.startsWith("/assets/") ||
		pathname.startsWith("/api/uploads/")
	);
}

export function cookieValue(request: Request, name: string) {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

// The system actor a public path runs as, when its own check (CRON_SECRET,
// a channel's signature, an upload link, a setup link or OAuth code) lets it
// through; null for paths that write nothing. /mcp runs as its token's actor
// (src/routes/mcp.ts).
export function publicActor(pathname: string): Actor | null {
	const systems: [string, SystemName][] = [
		["/api/cron/", "cron"],
		["/api/webhooks/", "webhook"],
		["/api/uploads/", "upload-link"],
		["/api/auth/", "sign-in"],
		["/api/oauth/", "oauth"],
	];
	const match = systems.find(([prefix]) => pathname.startsWith(prefix));
	return match ? systemActor(match[1]) : null;
}

export type Admission =
	| { kind: "public"; actor: Actor | null }
	| { kind: "signed-in"; actor: Actor; setCookie: string | null }
	| { kind: "refused"; response: Response };

// Signed-out pages go to sign-in and come back after; anything else (a server
// function, the PO PDF) is refused. A device whose person was removed counts
// as signed out. When a request renews the session, `setCookie` carries the
// fresh cookie to send with the response.
export async function admit(
	request: Request,
	db: Db = getDb(),
): Promise<Admission> {
	const url = new URL(request.url);
	if (isPublic(url.pathname))
		return { kind: "public", actor: publicActor(url.pathname) };
	const token = cookieValue(request, SESSION_COOKIE);
	const standing = token ? await standingOfSession(db, token) : null;
	if (token && standing?.kind === "signed-in")
		return {
			kind: "signed-in",
			actor: standing.actor,
			setCookie: standing.renewed ? sessionCookie(token) : null,
		};
	if (
		request.method === "GET" &&
		request.headers.get("accept")?.includes("text/html")
	)
		return {
			kind: "refused",
			response: new Response(null, {
				status: 302,
				headers: {
					Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
				},
			}),
		};
	return {
		kind: "refused",
		response: new Response("Signed out. Reload the page to sign in.", {
			status: 401,
		}),
	};
}

export async function guard(
	request: Request,
	db: Db = getDb(),
	onRenew?: (setCookie: string) => void,
): Promise<Response | null> {
	const admission = await admit(request, db);
	if (admission.kind === "refused") return admission.response;
	if (admission.kind === "signed-in" && admission.setCookie)
		onRenew?.(admission.setCookie);
	return null;
}
