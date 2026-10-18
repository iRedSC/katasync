import { createFileRoute } from "@tanstack/react-router";

// Where MCP clients register themselves and trade codes for tokens
// (src/auth/oauth.ts). Reachable signed out; a refusal answers
// 400 { error, error_description }, as OAuth clients expect.

const HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Cache-Control": "no-store",
};

// The token endpoint takes a form; registration takes JSON.
async function body(request: Request): Promise<Record<string, unknown>> {
	if (
		request.headers
			.get("content-type")
			?.includes("application/x-www-form-urlencoded")
	)
		return Object.fromEntries(new URLSearchParams(await request.text()));
	const json = await request.json().catch(() => ({}));
	return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

export const Route = createFileRoute("/api/oauth/$")({
	server: {
		handlers: {
			POST: async ({ params, request }) => {
				const [{ getDb }, oauth] = await Promise.all([
					import("#/db/client"),
					import("#/auth/oauth"),
				]);
				const db = getDb();
				const data = await body(request);
				try {
					switch (params._splat) {
						case "register":
							return Response.json(await oauth.registerClient(db, data), {
								status: 201,
								headers: HEADERS,
							});
						case "token": {
							const form = Object.fromEntries(
								Object.entries(data).map(([k, v]) => [
									k,
									typeof v === "string" ? v : undefined,
								]),
							);
							return Response.json(
								await oauth.exchange(db, form, oauth.originOf(request)),
								{ headers: HEADERS },
							);
						}
						default:
							return new Response("Not found", { status: 404 });
					}
				} catch (error) {
					if (error instanceof oauth.OAuthError)
						return Response.json(
							{ error: error.code, error_description: error.message },
							{ status: 400, headers: HEADERS },
						);
					throw error;
				}
			},
			OPTIONS: () => new Response(null, { status: 204, headers: HEADERS }),
		},
	},
});
