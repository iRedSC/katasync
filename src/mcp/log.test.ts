import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CAPABILITY_PATTERN, redactCapabilities } from "#/auth/capability-urls";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { logCalls } from "./log";
import { callMcp, freshDb } from "./mcp.fixtures";

let db: Db;
let blade: number;
beforeEach(async () => {
	({ db, blade } = await freshDb());
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

describe("upload links, which are their own credential", () => {
	// A tool's answer as /mcp sent it, logged as /mcp logs it.
	async function logged(name: string, args: Record<string, unknown>) {
		const result = await callMcp(db, true, "tools/call", {
			name,
			arguments: args,
		});
		const request = {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		};
		await logCalls(db, "Claude", request, { id: 1, result });
		const rows = await db.select().from(schema.mcpCalls);
		const row = rows.find((r) => r.tool === name);
		return { sent: String(result.content[0].text), kept: row?.result ?? "" };
	}

	async function sentPo(status: "draft" | "sent") {
		const [{ id: supplierId }] = await db
			.insert(schema.suppliers)
			.values({ code: `S${status}`, name: status })
			.returning();
		const [location] = await db.select().from(schema.locations);
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId, locationId: location.id, status })
			.returning();
		return po.id;
	}

	test("a PO file link is kept without its token, in the URL and the curl", async () => {
		vi.stubEnv("AUTH_ORIGIN", "https://katasync.test/");
		const { sent, kept } = await logged("po_file_upload_link", {
			po: await sentPo("draft"),
		});
		const [token] = /(?<=po-file\/)[\w-]{43}/.exec(sent) ?? [];
		expect(token).toBeDefined();
		expect(kept).not.toContain(token);
		expect(kept).toContain(
			'"url": "https://katasync.test/api/uploads/po-file/[redacted]"',
		);
		expect(kept).toContain(
			"curl -F file=@quote.pdf https://katasync.test/api/uploads/po-file/[redacted]",
		);
	});

	test("so is a damage's photo link", async () => {
		vi.stubEnv("AUTH_ORIGIN", "https://katasync.test");
		const po = await sentPo("sent");
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po,
			productId: blade,
			supplierCount: 1,
			quantity: 2,
		});
		await callMcp(db, true, "tools/call", {
			name: "receive_po_line",
			arguments: { po, sku: "BLADE", quantity: 2 },
		});
		const { sent, kept } = await logged("report_damage", {
			po,
			sku: "BLADE",
			quantity: 1,
			description: "handle snapped",
		});
		expect(sent).toMatch(/uploads\/damage\/[\w-]{43}/);
		expect(kept).not.toMatch(/uploads\/damage\/[\w-]{43}/);
		expect(kept.match(/uploads\/damage\/\[redacted\]/g)).toHaveLength(2);
	});

	test("ones already logged are scrubbed the same way", async () => {
		const token = "Zr4-x_9".repeat(6);
		const texts = [
			`{"url":"https://k.test/api/uploads/po-file/${token}","how":"curl -F file=@a.pdf https://k.test/api/uploads/po-file/${token}"}`,
			`photos: https://k.test/api/uploads/damage/${token}`,
			`https://k.test/api/shared-files/${token} and /setup?token=${token}`,
			"nothing secret, /api/uploads/po-file/[redacted]",
			`https://k.test/setup?from=mail&token=${token}`,
			`https%3A%2F%2Fk.test%2Fapi%2Fuploads%2Fdamage%2F${token}`,
			`https%3A%2F%2Fk.test%2Fsetup%3Ftoken%3D${token}`,
		];
		await db.insert(schema.mcpCalls).values(
			texts.map((text) => ({
				tokenName: "Claude",
				tool: "po_file_upload_link",
				arguments: { note: text },
				ok: true,
				result: text,
			})),
		);
		const migration = readFileSync(
			new URL(
				"../../drizzle/0153_scrub_mcp_capability_urls.sql",
				import.meta.url,
			),
			"utf8",
		);
		expect(migration).toContain(`'${CAPABILITY_PATTERN}'`);
		for (const statement of migration.split("--> statement-breakpoint"))
			await db.execute(sql.raw(statement));
		const rows = await db
			.select()
			.from(schema.mcpCalls)
			.orderBy(schema.mcpCalls.id);
		const expected = texts.map((t) => redactCapabilities(t, "[redacted]"));
		expect(rows.map((r) => r.result)).toEqual(expected);
		expect(rows.map((r) => r.arguments)).toEqual(
			expected.map((note) => ({ note })),
		);
		expect(JSON.stringify(rows)).not.toContain(token);
	});
});
