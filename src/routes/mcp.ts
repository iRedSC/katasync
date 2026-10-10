import { createFileRoute } from "@tanstack/react-router";

// katasync's MCP endpoint (Streamable HTTP, stateless): each request gets its
// own server and transport, so nothing is kept between calls. Callers prove
// who they are with an API token from Settings, sent as
// `Authorization: Bearer ks_...`. Tools are in src/mcp/server.ts.

async function handle(request: Request) {
	const [{ getDb }, { checkApiToken }, { buildServer }, transport] =
		await Promise.all([
			import("#/db/client"),
			import("#/auth/tokens"),
			import("#/mcp/server"),
			import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
		]);
	const db = getDb();
	const token = /^Bearer (.+)$/.exec(
		request.headers.get("authorization") ?? "",
	)?.[1];
	if (!token || !(await checkApiToken(db, token)))
		return Response.json(
			{ error: "Send an API token from katasync's Settings as a Bearer token" },
			{ status: 401, headers: { "WWW-Authenticate": "Bearer" } },
		);
	const server = buildServer(db);
	const http = new transport.WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(http);
	return http.handleRequest(request);
}

export const Route = createFileRoute("/mcp")({
	server: {
		handlers: {
			POST: ({ request }) => handle(request),
			// Stateless: no event stream to open and no session to end. The
			// transport answers these with 405.
			GET: ({ request }) => handle(request),
			DELETE: ({ request }) => handle(request),
		},
	},
});
