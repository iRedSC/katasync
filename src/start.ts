import { createMiddleware, createStart } from "@tanstack/react-start";

// Everything needs a signed-in device except the sign-in pages (see
// src/auth/guard.ts). The dev server skips this: passkeys are tied to the
// production address, and dev is only reachable over Tailscale.
//
// Cross-site form posts are covered by the session cookie being SameSite=Lax:
// without the cookie a request is refused.
const signedIn = createMiddleware().server(async ({ request, next }) => {
	if (import.meta.env.DEV) return next();
	const [{ guard }, { getDb }] = await Promise.all([
		import("#/auth/guard"),
		import("#/db/client"),
	]);
	const renewed: { cookie?: string } = {};
	const refused = await guard(request, getDb(), (setCookie) => {
		renewed.cookie = setCookie;
	});
	if (refused) return refused;
	const result = await next();
	if (!renewed.cookie) return result;
	// The session was renewed, so the cookie's lifetime moves with it. The
	// headers of a response from elsewhere may be read-only, so copy it.
	const headers = new Headers(result.response.headers);
	headers.append("Set-Cookie", renewed.cookie);
	return {
		...result,
		response: new Response(result.response.body, {
			status: result.response.status,
			statusText: result.response.statusText,
			headers,
		}),
	};
});

export const startInstance = createStart(() => ({
	requestMiddleware: [signedIn],
}));
