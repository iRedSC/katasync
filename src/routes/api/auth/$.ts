import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { createFileRoute } from "@tanstack/react-router";
import { type } from "arktype";

// Creating a passkey and signing in, reachable while signed out. Each step is
// a POST with a JSON body; a refusal answers 400 { error } for the page to
// show.

// The cookie is built in src/auth/sessions.ts, which is imported inside the
// handler to keep it out of the browser bundle.
const withCookie = (setCookie: string) =>
	Response.json({ ok: true }, { headers: { "Set-Cookie": setCookie } });

// The browser's WebAuthn answer is checked by the WebAuthn library itself.
const setupBody = type({ setupToken: "string > 0" });
const registerBody = type({
	setupToken: "string > 0",
	name: "string",
	response: "object",
});
const loginBody = type({ response: "object" });

class BadRequest extends Error {}
function parse<T>(schema: (data: unknown) => T | type.errors, data: unknown) {
	const out = schema(data);
	if (out instanceof type.errors) throw new BadRequest(out.summary);
	return out;
}

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			POST: async ({ params, request }) => {
				const [{ getDb }, auth, sessions, { cookieValue }] = await Promise.all([
					import("#/db/client"),
					import("#/auth/webauthn"),
					import("#/auth/sessions"),
					import("#/auth/guard"),
				]);
				const db = getDb();
				const json = await request.json().catch(() => ({}));
				try {
					switch (params._splat) {
						case "register/link": {
							const { setupToken } = parse(setupBody, json);
							return Response.json(await auth.setupLinkFor(db, setupToken));
						}
						case "register/options": {
							const { setupToken } = parse(setupBody, json);
							return Response.json(
								await auth.registrationOptions(db, setupToken),
							);
						}
						case "register/verify": {
							const b = parse(registerBody, json);
							const token = await auth.finishRegistration(db, {
								setupToken: b.setupToken,
								name: b.name,
								response: b.response as RegistrationResponseJSON,
							});
							return withCookie(sessions.sessionCookie(token));
						}
						case "login/options":
							return Response.json(await auth.authenticationOptions(db));
						case "login/verify": {
							const b = parse(loginBody, json);
							const token = await auth.finishAuthentication(
								db,
								b.response as AuthenticationResponseJSON,
							);
							return withCookie(sessions.sessionCookie(token));
						}
						case "logout": {
							const token = cookieValue(request, sessions.SESSION_COOKIE);
							if (token) await sessions.endSession(db, token);
							return withCookie(sessions.sessionCookie("", 0));
						}
						default:
							return new Response("Not found", { status: 404 });
					}
				} catch (error) {
					// The WebAuthn library throws plain Errors for answers that
					// don't check out (wrong challenge, origin, signature).
					const refused =
						error instanceof sessions.AuthError ||
						error instanceof BadRequest ||
						params._splat?.endsWith("/verify");
					console.error(`auth ${params._splat}:`, error);
					return Response.json(
						{ error: error instanceof Error ? error.message : String(error) },
						{ status: refused ? 400 : 500 },
					);
				}
			},
		},
	},
});
