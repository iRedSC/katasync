import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { logCalls } from "./log";
import { freshDb } from "./mcp.fixtures";

let db: Db;
beforeEach(async () => {
	({ db } = await freshDb());
});

describe("what's kept of a call's arguments", () => {
	const call = (name: string, args: unknown) => ({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
	const failed = {
		id: 1,
		result: { isError: true, content: [{ text: "no" }] },
	};

	test("leaves out credentials, by name and by look, at any depth", async () => {
		const token = "ks_abcdefghijklmnopqrstuvwxyz0123";
		await logCalls(
			db,
			"Claude",
			call("record_count", {
				sku: "X",
				api_key: "abc",
				headers: { Authorization: `Bearer ${token}` },
				notes: [`pasted ${token} by mistake`, { password: "hunter2" }],
			}),
			failed,
		);
		const [row] = await db.select().from(schema.mcpCalls);
		expect(row.arguments).toEqual({
			sku: "X",
			api_key: "[redacted]",
			headers: { Authorization: "[redacted]" },
			notes: ["pasted [redacted] by mistake", { password: "[redacted]" }],
		});
	});

	test("cuts big arguments short, for unknown tools too", async () => {
		await logCalls(
			db,
			"Claude",
			call("no_such_tool".repeat(50), { blob: "x".repeat(100_000) }),
			failed,
		);
		const [row] = await db.select().from(schema.mcpCalls);
		expect(row.tool).toHaveLength(100);
		expect(JSON.stringify(row.arguments).length).toBeLessThan(4200);
		expect(row.arguments).toMatchObject({ length: expect.any(Number) });
	});

	test("survives text a database can't hold", async () => {
		await logCalls(
			db,
			"Claude",
			call("record_count", { sku: "A\u0000B" }),
			failed,
		);
		const [row] = await db.select().from(schema.mcpCalls);
		expect(row.arguments).toEqual({ sku: "AB" });
	});
});

test("logs calls to changing tools, not reads", async () => {
	const request = [
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "query", arguments: { sql: "select 1" } },
		},
		{
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "record_count", arguments: { sku: "X", counted: 1 } },
		},
		{ jsonrpc: "2.0", id: 3, method: "tools/list" },
	];
	const response = [
		{ id: 1, result: { content: [{ text: "rows" }] } },
		{
			id: 2,
			result: { isError: true, content: [{ text: "No product with SKU X" }] },
		},
	];
	expect(await logCalls(db, "Claude", request, response)).toBe(1);
	const [row] = await db.select().from(schema.mcpCalls);
	expect(row).toMatchObject({
		tokenName: "Claude",
		tool: "record_count",
		arguments: { sku: "X", counted: 1 },
		ok: false,
		result: "No product with SKU X",
	});
});
