import { createFileRoute } from "@tanstack/react-router";

// katasync's MCP endpoint (Streamable HTTP, stateless): each request gets its
// own server and transport, so nothing is kept between calls. Callers sign in
// with OAuth (src/auth/oauth.ts): without a token, the 401 points them to
// the metadata that starts it. An app approved read only gets only the tools
// that read. Every change is logged (src/mcp/log.ts) and runs as whoever the
// connection acts for right now (checkAccessToken), so the audit log credits
// it to them. Tools are in src/mcp/server.ts.

const toolNames = (body: unknown) =>
	(Array.isArray(body) ? body : [body])
		.map((m) =>
			m && typeof m === "object" && "params" in m
				? (m.params as { name?: unknown } | null)?.name
				: undefined,
		)
		.filter((n): n is string => typeof n === "string");

async function handle(request: Request) {
	const [
		{ getDb },
		oauth,
		{ buildServer },
		{ hasChanges, logCalls },
		transport,
		{ runAs },
		{ describeActor },
	] = await Promise.all([
		import("#/db/client"),
		import("#/auth/oauth"),
		import("#/mcp/server"),
		import("#/mcp/log"),
		import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
		import("#/audit/context"),
		import("#/auth/actor"),
	]);
	const db = getDb();
	const bearer = /^Bearer (.+)$/.exec(
		request.headers.get("authorization") ?? "",
	)?.[1];
	const token = bearer ? await oauth.checkAccessToken(db, bearer) : null;
	if (!token) {
		const metadata = oauth.endpoints(oauth.originOf(request)).resourceMetadata;
		// A token that was sent but isn't good tells the app to refresh it.
		const challenge = bearer
			? `Bearer error="invalid_token", resource_metadata="${metadata}"`
			: `Bearer resource_metadata="${metadata}"`;
		return Response.json(
			{ error: "Connect to katasync first; your MCP client signs in for you" },
			{ status: 401, headers: { "WWW-Authenticate": challenge } },
		);
	}

	// Read here so the call can be logged; the transport is handed the same
	// body below.
	const body =
		request.method === "POST"
			? await request
					.clone()
					.json()
					.catch(() => undefined)
			: undefined;
	const operation = `mcp ${toolNames(body).join(",")}`.trim();
	const response = await runAs(token.actor, operation, async () => {
		const server = buildServer(db, { canWrite: token.canWrite });
		const http = new transport.WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(http);
		return http.handleRequest(request, { parsedBody: body });
	});
	// Only a request with a change is logged, so only then is its reply read.
	if (body !== undefined && response.ok && hasChanges(body)) {
		const reply = await response
			.clone()
			.json()
			.catch(() => undefined);
		await logCalls(db, describeActor(token.actor), body, reply).catch((error) =>
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
