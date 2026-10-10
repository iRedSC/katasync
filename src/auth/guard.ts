import { type Db, getDb } from "#/db/client";
import { SESSION_COOKIE, sessionFor } from "./sessions";

// Decides, for every request, whether it may go ahead without a session.
// Server only; src/start.ts runs it, except on the dev server.

// Reachable while signed out: the sign-in and setup pages, their API, and
// the files those pages load.
const PUBLIC_PATHS = new Set([
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
		pathname.startsWith("/assets/")
	);
}

export function cookieValue(request: Request, name: string) {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

// Signed-out pages go to sign-in and come back after; anything else (a server
// function, the PO PDF) is refused.
export async function guard(
	request: Request,
	db: Db = getDb(),
): Promise<Response | null> {
	const url = new URL(request.url);
	if (isPublic(url.pathname)) return null;
	const token = cookieValue(request, SESSION_COOKIE);
	if (token && (await sessionFor(db, token))) return null;
	if (
		request.method === "GET" &&
		request.headers.get("accept")?.includes("text/html")
	)
		return new Response(null, {
			status: 302,
			headers: {
				Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
			},
		});
	return new Response("Signed out. Reload the page to sign in.", {
		status: 401,
	});
}
