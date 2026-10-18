import { createFileRoute } from "@tanstack/react-router";

// The documents an MCP client reads to find out how to sign in to /mcp:
// which server guards it (RFC 9728), and that server's endpoints (RFC 8414).
// Clients ask with and without the "/mcp" suffix, so both are answered.

const CORS = { "Access-Control-Allow-Origin": "*" };

export const Route = createFileRoute("/.well-known/$")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const { endpoints, originOf } = await import("#/auth/oauth");
				const e = endpoints(originOf(request));
				const [doc] = (params._splat ?? "").split("/");
				if (doc === "oauth-protected-resource")
					return Response.json(
						{
							resource: e.resource,
							authorization_servers: [e.issuer],
							bearer_methods_supported: ["header"],
							resource_name: "katasync",
						},
						{ headers: CORS },
					);
				if (
					doc === "oauth-authorization-server" ||
					doc === "openid-configuration"
				)
					return Response.json(
						{
							issuer: e.issuer,
							authorization_endpoint: e.authorize,
							token_endpoint: e.token,
							registration_endpoint: e.register,
							response_types_supported: ["code"],
							grant_types_supported: ["authorization_code", "refresh_token"],
							code_challenge_methods_supported: ["S256"],
							token_endpoint_auth_methods_supported: ["none"],
							scopes_supported: ["read", "write"],
							authorization_response_iss_parameter_supported: true,
						},
						{ headers: CORS },
					);
				return new Response("Not found", { status: 404 });
			},
			OPTIONS: () => new Response(null, { status: 204, headers: CORS }),
		},
	},
});
