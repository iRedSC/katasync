import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type Db, withOwnConnection } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct } from "#/test/db";
import { freshDb } from "./mcp.fixtures";
import {
	describeSchema,
	MCP_ROLE,
	mcpConnectionString,
	mcpPassword,
	readOnlyQuery as run,
	SECRET_TABLES,
} from "./query";

let db: Db;
beforeEach(async () => {
	({ db } = await freshDb());
});

describe("read-only queries", () => {
	// Each query opens its connection with withOwnConnection, the production code
	// that makes a pg Client and ends it. No network here: the Client's queries
	// run on the test database, and each Client's calls are logged in order, so
	// the test sees what happened to the Client that did the work.
	let calls: Map<Client, string[]>;
	beforeEach(() => {
		calls = new Map();
		const log = (client: Client, call: string) =>
			calls.set(client, [...(calls.get(client) ?? []), call]);
		vi.spyOn(Client.prototype, "connect").mockImplementation(async function (
			this: Client,
		) {
			log(this, "connect");
		});
		vi.spyOn(Client.prototype, "query").mockImplementation(async function (
			this: Client,
			config: { text: string; values?: unknown[]; rowMode?: "array" },
			values?: unknown[],
		) {
			log(this, "query");
			const pglite = (db as unknown as { $client: PGlite }).$client;
			return pglite.query(config.text, values ?? config.values ?? [], {
				rowMode: config.rowMode,
			});
		} as never);
		vi.spyOn(Client.prototype, "end").mockImplementation(async function (
			this: Client,
		) {
			log(this, "end");
		});
	});
	const readOnlyQuery = (text: string, limit?: number) =>
		run(text, limit, (use) =>
			withOwnConnection(use, "postgresql://katasync_mcp@test.invalid/katasync"),
		);

	test("return rows and say when they were cut off", async () => {
		await createProduct(db, "KNIFE", "simple");
		const all = await readOnlyQuery("select sku from products order by sku;");
		expect(all).toEqual({
			rows: [{ sku: "BLADE" }, { sku: "KNIFE" }],
			truncated: false,
		});
		const one = await readOnlyQuery("select sku from products -- comment", 1);
		expect(one.truncated).toBe(true);
	});

	test("can't write, even smuggled after the select", async () => {
		await expect(
			readOnlyQuery("delete from products returning *"),
		).rejects.toThrow();
		await expect(
			readOnlyQuery(
				"select 1) q; delete from products; select * from (select 1",
			),
		).rejects.toThrow();
		await expect(
			readOnlyQuery(
				"with gone as (delete from products returning *) select * from gone",
			),
		).rejects.toThrow();
		expect(await db.select().from(schema.products)).toHaveLength(1);
	});

	test("say what Postgres said, and name the tables when one doesn't exist", async () => {
		await expect(
			readOnlyQuery("select * from purchase_order_line"),
		).rejects.toThrow(
			/purchase_order_line" does not exist\. Tables and views: .*purchase_order_lines/,
		);
		await expect(readOnlyQuery("select nope from products")).rejects.toThrow(
			/column "nope" does not exist\. describe_schema/,
		);
	});

	test("each query gets a connection of its own, closed after its last query", async () => {
		await readOnlyQuery("select 1");
		await expect(readOnlyQuery("select * from nope")).rejects.toThrow();
		const sessions = [...calls.values()];
		expect(sessions).toHaveLength(2);
		for (const session of sessions) {
			expect(session[0]).toBe("connect");
			expect(session).toContain("query");
			expect(session.at(-1)).toBe("end");
		}
	});

	test("can't change the session for whoever uses the connection next", async () => {
		const searchPath = async () =>
			(
				(await db.execute(sql`show search_path`)) as unknown as {
					rows: { search_path: string }[];
				}
			).rows[0].search_path;
		const before = await searchPath();
		for (const text of [
			"select set_config('search_path', 'pg_catalog', false)",
			"select \"SET_CONFIG\"('search_path', 'pg_catalog', false)",
			"select pg_catalog.set_config('search_path', 'pg_catalog', false)",
		])
			await expect(readOnlyQuery(text)).rejects.toThrow(/isn't available/);
		expect(await searchPath()).toBe(before);
		expect((await readOnlyQuery("select sku from products")).rows).toHaveLength(
			1,
		);
	});

	test("refuses sign-in tables and file or remote functions", async () => {
		for (const text of [
			"select * from sessions",
			"select token_hash from oauth_tokens",
			"select * from oauth_clients",
			"select * from public.passkeys",
			'select * from "setup_links"',
			"select count(*) from auth_challenges",
			"select private_key from qz_certificate",
			"select pg_read_file('/etc/passwd')",
			"select * from dblink('host=elsewhere', 'select 1') as t(a int)",
			"select pg_terminate_backend(pid) from pg_stat_activity",
		])
			await expect(readOnlyQuery(text)).rejects.toThrow(/isn't available/);
		expect(calls.size).toBe(0);
	});

	test("as katasync_mcp, can't read a secret table however the query is spelled", async () => {
		const asMcp = (text: string) =>
			run(text, undefined, async (use) => {
				await db.execute(sql`set session authorization katasync_mcp`);
				try {
					return await use(db);
				} finally {
					await db.execute(sql`reset session authorization`);
				}
			});
		await db.insert(schema.oauthClients).values({
			id: "c",
			name: "Claude",
			redirectUris: ["https://claude.ai/cb"],
		});
		const escaped = 'select id from U&"oauth\\005fclients"';
		// The name check alone misses it: as the owner it reads the hash.
		expect((await readOnlyQuery(escaped)).rows).toHaveLength(1);
		for (const text of [
			escaped,
			"select query_to_xml('select id from oauth_'||'clients', true, false, '')",
			// Switching role back first doesn't help: katasync_mcp isn't a member.
			`select * from (select U&"set\\005fconfig"('role', 'postgres', true) a,
				query_to_xml('select * from sess'||'ions', true, false, '') b) q`,
			`select U&"set\\005fconfig"('role', 'postgres', true)`,
		])
			await expect(asMcp(text)).rejects.toMatchObject({
				cause: { message: expect.stringMatching(/permission denied/) },
			});
		expect((await asMcp("select sku from products")).rows).toHaveLength(1);
	});

	test("katasync_mcp can read every table and view but the secret ones", async () => {
		// A new table needs GRANT SELECT ... TO katasync_mcp in its migration,
		// or its name in SECRET_TABLES.
		const { rows } = (await db.execute(sql`
			select c.relname as name, has_table_privilege('katasync_mcp', c.oid, 'select') as can
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
			order by c.relname
		`)) as unknown as { rows: { name: string; can: boolean }[] };
		expect(rows.length).toBeGreaterThan(SECRET_TABLES.length);
		expect(rows.map((r) => [r.name, r.can])).toEqual(
			rows.map((r) => [r.name, !SECRET_TABLES.includes(r.name)]),
		);
		for (const table of SECRET_TABLES)
			expect(rows.map((r) => r.name)).toContain(table);
	});

	test("logs in as katasync_mcp even when DATABASE_URL names a user in its query", () => {
		const url = new URL(
			mcpConnectionString(
				"postgresql://owner:secret@db.example/neondb?user=owner&password=secret&sslmode=require",
				"abc123",
			),
		);
		expect([url.username, url.password]).toEqual([MCP_ROLE, "abc123"]);
		expect(url.searchParams.has("user")).toBe(false);
		expect(url.searchParams.has("password")).toBe(false);
		expect(url.searchParams.get("sslmode")).toBe("require");
	});

	test("the katasync_mcp password is made once and kept", async () => {
		const first = await mcpPassword(db);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await mcpPassword(db)).toBe(first);
	});

	test("the schema lists tables and views but not sign-in bookkeeping", async () => {
		const tables = await describeSchema(db);
		expect(tables.products.kind).toBe("table");
		expect(tables.owned_stock.kind).toBe("view");
		expect(tables.sales_units.columns).toContain("units integer");
		expect(tables.sessions).toBeUndefined();
		expect(tables.qz_certificate).toBeUndefined();
	});
});
