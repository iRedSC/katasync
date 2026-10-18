import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { buildServer } from "./server";

// A fresh test database as each test starts: a BLADE product and an owned
// location called Warehouse.
export async function freshDb() {
	const db = await createTestDb();
	const blade = await createProduct(db, "BLADE", "simple");
	await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" });
	return { db, blade };
}

// One stateless request, as /mcp handles it.
export async function callMcp(
	db: Db,
	canWrite: boolean,
	method: string,
	params: Record<string, unknown> = {},
) {
	const server = buildServer(db, { canWrite });
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	const response = await transport.handleRequest(
		new Request("http://katasync.test/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}),
	);
	const body = await response.json();
	if (body.error) throw new Error(JSON.stringify(body.error));
	return body.result;
}

// A tool call over MCP, as the tool's caller sees it.
export async function callTool(
	db: Db,
	canWrite: boolean,
	name: string,
	args: Record<string, unknown>,
) {
	const result = await callMcp(db, canWrite, "tools/call", {
		name,
		arguments: args,
	});
	return {
		isError: Boolean(result.isError),
		data: result.isError
			? result.content[0].text
			: JSON.parse(result.content[0].text),
	};
}
