import { createMiddleware, createStart } from "@tanstack/react-start";

// Everything needs a signed-in device except the sign-in pages (see
// src/auth/guard.ts). The dev server skips this: passkeys are tied to the
// production address, and dev is only reachable over Tailscale.
//
// Cross-site form posts are covered by the session cookie being SameSite=Lax:
// without the cookie a request is refused.
const signedIn = createMiddleware().server(async ({ request, next }) => {
	if (import.meta.env.DEV) return next();
	const { guard } = await import("#/auth/guard");
	return (await guard(request)) ?? next();
});

export const startInstance = createStart(() => ({
	requestMiddleware: [signedIn],
}));
