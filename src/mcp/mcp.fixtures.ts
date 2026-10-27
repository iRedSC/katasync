import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { currentContext, runAs } from "#/audit/context";
import { type Actor, systemActor } from "#/auth/actor";
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
	actor: Actor | null = systemActor("script"),
) {
	const server = buildServer(db, { canWrite });
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	const request = () =>
		transport.handleRequest(
			new Request("http://katasync.test/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			}),
		);
	const response =
		currentContext() || actor === null
			? await request()
			: await runAs(actor, "test:mcp", request);
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
	const text: string = result.content[0].text;
	// An email tool's answer comes inside untrusted-content tags
	// (src/mcp/server/email-files.ts).
	const inner = /^<(untrusted-content-[0-9a-f]{16})>\n([\s\S]*)\n<\/\1>$/.exec(
		text,
	)?.[2];
	const body = inner ?? text;
	return {
		isError: Boolean(result.isError),
		untrusted: inner !== undefined,
		data: result.isError ? body : JSON.parse(body),
	};
}
