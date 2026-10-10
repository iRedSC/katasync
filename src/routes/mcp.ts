import { createFileRoute } from "@tanstack/react-router";

// katasync's MCP endpoint (Streamable HTTP, stateless): each request gets its
// own server and transport, so nothing is kept between calls. Callers prove
// who they are with an API token from Settings, sent as
// `Authorization: Bearer ks_...`; a read-only token gets only the tools that
// read. Every change is logged (src/mcp/log.ts). Tools are in
// src/mcp/server.ts.

async function handle(request: Request) {
	const [
		{ getDb },
		{ checkApiToken },
		{ buildServer },
		{ logCalls },
		transport,
	] = await Promise.all([
		import("#/db/client"),
		import("#/auth/tokens"),
		import("#/mcp/server"),
		import("#/mcp/log"),
		import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
	]);
	const db = getDb();
	const bearer = /^Bearer (.+)$/.exec(
		request.headers.get("authorization") ?? "",
	)?.[1];
	const token = bearer ? await checkApiToken(db, bearer) : null;
	if (!token)
		return Response.json(
			{ error: "Send an API token from katasync's Settings as a Bearer token" },
			{ status: 401, headers: { "WWW-Authenticate": "Bearer" } },
		);

	// Read here so the call can be logged; the transport is handed the same
	// body below.
	const body =
		request.method === "POST"
			? await request
					.clone()
					.json()
					.catch(() => undefined)
			: undefined;
	const server = buildServer(db, { canWrite: token.canWrite });
	const http = new transport.WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(http);
	const response = await http.handleRequest(request, { parsedBody: body });
	if (body !== undefined && response.ok) {
		const reply = await response
			.clone()
			.json()
			.catch(() => undefined);
		await logCalls(db, token.name, body, reply).catch((error) =>
			console.error("Couldn't log an MCP call:", error),
		);
	}
	return response;
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
