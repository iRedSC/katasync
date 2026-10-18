import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { logCalls } from "./log";
import {
	describeSchema,
	MCP_ROLE,
	mcpConnectionString,
	mcpPassword,
	readOnlyQuery as run,
	SECRET_TABLES,
} from "./query";
import { buildServer, READ_TOOLS } from "./server";

let db: Db;
let blade: number;
beforeEach(async () => {
	db = await createTestDb();
	blade = await createProduct(db, "BLADE", "simple");
	await db
		.insert(schema.locations)
		.values({ name: "Warehouse", kind: "owned" });
});

describe("read-only queries", () => {
	// Stands in for a connection of its own: the test database, counting opens
	// and closes the way withOwnConnection would.
	let opened = 0;
	let closed = 0;
	beforeEach(() => {
		opened = 0;
		closed = 0;
	});
	const readOnlyQuery = (text: string, limit?: number) =>
		run(text, limit, async (use) => {
			opened++;
			try {
				return await use(db);
			} finally {
				closed++;
			}
		});

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

	test("each query gets a connection of its own, closed afterwards", async () => {
		await readOnlyQuery("select 1");
		await expect(readOnlyQuery("select * from nope")).rejects.toThrow();
		expect({ opened, closed }).toEqual({ opened: 2, closed: 2 });
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
		expect(opened).toBe(0);
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

describe("over MCP", () => {
	let canWrite = true;
	beforeEach(() => {
		canWrite = true;
	});
	// One stateless request, as /mcp handles it.
	async function call(method: string, params: Record<string, unknown> = {}) {
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
	const tool = async (name: string, args: Record<string, unknown>) => {
		const result = await call("tools/call", { name, arguments: args });
		return {
			isError: Boolean(result.isError),
			data: result.isError
				? result.content[0].text
				: JSON.parse(result.content[0].text),
		};
	};

	test("lists its tools, marking which only read", async () => {
		const { tools } = await call("tools/list");
		const byName = new Map(
			tools.map((t: { name: string; annotations: object }) => [
				t.name,
				t.annotations,
			]),
		);
		expect(byName.get("query")).toMatchObject({ readOnlyHint: true });
		expect(byName.get("set_draft_po_lines")).toMatchObject({
			readOnlyHint: false,
		});
		expect(byName.get("delete_draft_po")).toMatchObject({
			destructiveHint: true,
		});
		expect(byName.has("send_purchase_order")).toBe(false);
		// /mcp logs every tool not listed as reading; the list must be right.
		const reading = tools
			.filter(
				(t: { annotations: { readOnlyHint?: boolean } }) =>
					t.annotations.readOnlyHint,
			)
			.map((t: { name: string }) => t.name)
			.sort();
		expect(reading).toEqual([...READ_TOOLS].sort());
	});

	test("puts lines on each supplier's draft and reports what it skipped", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		await db.insert(schema.productSuppliers).values({
			productId: blade,
			supplierId: canam,
			supplierCount: 1,
			cost: 2,
			minimumQuantity: 5,
		});
		await createProduct(db, "LOOSE", "simple");
		const { data } = await tool("set_draft_po_lines", {
			quantity_in: "purchase_unit",
			lines: [
				{ sku: "BLADE", quantity: 3 },
				{ sku: "LOOSE", quantity: 1 },
				{ sku: "NOPE", quantity: 1 },
			],
		});
		expect(data.drafts).toMatchObject([
			{
				supplier: "CanAm",
				set: [
					{
						sku: "BLADE",
						quantity: 3,
						warning: "below the supplier's minimum of 5",
					},
				],
			},
		]);
		expect(data.skipped).toEqual([
			{ sku: "LOOSE", reason: "no supplier set" },
			{ sku: "NOPE", reason: "No product with SKU NOPE" },
		]);
		const [line] = await db.select().from(schema.purchaseOrderLines);
		expect(line).toMatchObject({ productId: blade, quantity: 3, unitCost: 2 });
	});

	test("deletes a draft PO but never a sent one", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const [{ id: locationId }] = await db.select().from(schema.locations);
		const [draft] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId, status: "draft" })
			.returning();
		const [sent] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId, status: "sent" })
			.returning();
		const refused = await tool("delete_draft_po", { po: sent.id });
		expect(refused).toMatchObject({ isError: true });
		expect(refused.data).toMatch(/is sent/);
		const deleted = await tool("delete_draft_po", { po: draft.id });
		expect(deleted.data).toEqual({ deleted: draft.id });
		const po = async (id: number) =>
			(
				await db
					.select()
					.from(schema.purchaseOrders)
					.where(eq(schema.purchaseOrders.id, id))
			)[0];
		expect((await po(sent.id)).status).toBe("sent");
		expect(await po(draft.id)).toBeUndefined();
	});

	test("creates boxes all or none", async () => {
		const made = await tool("create_boxes", {
			boxes: [
				{ pin: 1, length_in: 3, width_in: 3, height_in: 6, weight_oz: 0 },
			],
		});
		expect(made.data).toEqual([{ pin: 1, name: "3 × 3 × 6" }]);
		const clash = await tool("create_boxes", {
			boxes: [
				{ pin: 2, length_in: 4, width_in: 4, height_in: 4, weight_oz: 1 },
				{ pin: 1, length_in: 5, width_in: 5, height_in: 5, weight_oz: 1 },
			],
		});
		expect(clash).toMatchObject({ isError: true });
		expect(clash.data).toMatch(/Pin 1 is already 3 × 3 × 6/);
		expect(await db.select().from(schema.packages)).toHaveLength(1);
	});

	test("counts stock and undoes it", async () => {
		const counted = await tool("record_count", { sku: "BLADE", counted: 7 });
		expect(counted.data).toMatchObject({ delta: 7, onHand: 7 });
		await tool("undo_stock_change", { batch_id: counted.data.batchId });
		const [level] = await db
			.select()
			.from(schema.stockLevels)
			.where(eq(schema.stockLevels.productId, blade));
		expect(level.onHand).toBe(0);
	});

	test("requested counts stay due until counted, and come back on undo", async () => {
		const due = async () =>
			(
				await db
					.select({
						requested: schema.stockLevels.countRequestedAt,
						counted: schema.stockLevels.lastCountedAt,
					})
					.from(schema.stockLevels)
					.where(eq(schema.stockLevels.productId, blade))
			).filter((l) => l.requested && (!l.counted || l.counted < l.requested))
				.length;
		const asked = await tool("request_counts", { skus: ["BLADE", "BLADE"] });
		expect(asked.data).toEqual({ requested: 1 });
		expect(await due()).toBe(1);
		const counted = await tool("record_count", { sku: "BLADE", counted: 3 });
		expect(await due()).toBe(0);
		await tool("undo_stock_change", { batch_id: counted.data.batchId });
		expect(await due()).toBe(1);
	});

	test("a read-only token gets only the reading tools", async () => {
		canWrite = false;
		const { tools } = await call("tools/list");
		expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(
			[...READ_TOOLS].sort(),
		);
		const tried = await call("tools/call", {
			name: "record_count",
			arguments: { sku: "BLADE", counted: 1 },
		});
		expect(tried.isError).toBe(true);
	});

	test("orders items as whole packs, in a line's own unit if it has one", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		await db.insert(schema.productSuppliers).values({
			productId: blade,
			supplierId: canam,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			cost: 24,
		});
		const first = await tool("set_draft_po_lines", {
			quantity_in: "items",
			lines: [{ sku: "BLADE", quantity: 30 }],
		});
		expect(first.data.drafts[0].set[0]).toMatchObject({
			quantity: 3,
			unit: "CASE",
			items: 36,
		});
		// This PO buys it in boxes of 6 instead.
		await tool("set_po_line_terms", {
			po: first.data.drafts[0].po,
			sku: "BLADE",
			unit: "BOX",
			pack_size: 6,
			minimum: 1,
		});
		const again = await tool("set_draft_po_lines", {
			quantity_in: "items",
			lines: [{ sku: "BLADE", quantity: 30 }],
		});
		expect(again.data.drafts[0].set[0]).toMatchObject({
			quantity: 5,
			unit: "BOX",
			items: 30,
		});
	});

	test("changes product details, kit parts, and builds kits", async () => {
		const kit = await createProduct(db, "KIT", "kit");
		const product = await tool("update_product", {
			sku: "BLADE",
			unit_cost: 1.5,
			weight_oz: 2,
			barcode: "123",
		});
		expect(product.data).toMatchObject({
			unitCost: 1.5,
			weightGrams: 57,
			barcode: "123",
		});
		const dupe = await tool("update_product", { sku: "KIT", barcode: "123" });
		expect(dupe.data).toMatch(/already on BLADE/);

		await tool("set_components", {
			sku: "KIT",
			components: [{ sku: "BLADE", quantity: 2 }],
		});
		await tool("record_count", { sku: "BLADE", counted: 4 });
		const built = await tool("assemble_kits", { sku: "KIT", quantity: 2 });
		expect(built.isError).toBe(false);
		const short = await tool("assemble_kits", { sku: "KIT", quantity: 1 });
		expect(short.isError).toBe(true);
		const levels = await db.select().from(schema.stockLevels);
		expect(
			Object.fromEntries(levels.map((l) => [l.productId, l.onHand])),
		).toEqual({ [blade]: 0, [kit]: 2 });
	});

	test("receives a sent PO in its unit and undoes it", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const [location] = await db.select().from(schema.locations);
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "sent" })
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po.id,
			productId: blade,
			unit: "CASE",
			packSize: 12,
			supplierCount: 12,
			quantity: 2,
		});
		const got = await tool("receive_po_line", {
			po: po.id,
			sku: "BLADE",
			quantity: 1,
		});
		expect(got.data).toMatchObject({ closed: false });
		const [level] = await db.select().from(schema.stockLevels);
		expect(level.onHand).toBe(12);
		await tool("undo_po_receipt", { receipt_id: got.data.receiptId });
		const [after] = await db.select().from(schema.stockLevels);
		expect(after.onHand).toBe(0);
	});

	test("notes a line for receiving, and takes the note off", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const [location] = await db.select().from(schema.locations);
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "sent" })
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po.id,
			productId: blade,
			supplierCount: 1,
			quantity: 2,
		});
		const set = await tool("set_po_line_note", {
			po: po.id,
			sku: "BLADE",
			note: "  1 crushed, kept  ",
		});
		expect(set.data).toMatchObject({ was: null, note: "1 crushed, kept" });
		const shown = await tool("get_purchase_order", { id: po.id });
		expect(shown.data.lines[0].receivingNote).toBe("1 crushed, kept");
		const cleared = await tool("set_po_line_note", {
			po: po.id,
			sku: "BLADE",
			note: " ",
		});
		expect(cleared.data).toMatchObject({ was: "1 crushed, kept", note: null });
		await db
			.update(schema.purchaseOrders)
			.set({ status: "draft" })
			.where(eq(schema.purchaseOrders.id, po.id));
		const onDraft = await tool("set_po_line_note", {
			po: po.id,
			sku: "BLADE",
			note: "x",
		});
		expect(onDraft.isError).toBe(true);
	});

	test("changes a sent PO to match what came, without changing what was sent", async () => {
		const [{ id: canam }] = await db
			.insert(schema.suppliers)
			.values({ code: "CANAM", name: "CanAm" })
			.returning();
		const knife = await createProduct(db, "KNIFE", "simple");
		await db.insert(schema.productSuppliers).values({
			productId: knife,
			supplierId: canam,
			supplierCount: 1,
			cost: 9,
		});
		const [location] = await db.select().from(schema.locations);
		const [draft] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "draft" })
			.returning();
		const [po] = await db
			.insert(schema.purchaseOrders)
			.values({ supplierId: canam, locationId: location.id, status: "sent" })
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po.id,
			productId: blade,
			supplierCount: 1,
			quantity: 10,
			unitCost: 2,
			sentQuantity: 10,
			sentUnitCost: 2,
		});

		const onDraft = await tool("add_to_sent_po", {
			po: draft.id,
			sku: "KNIFE",
			quantity: 1,
		});
		expect(onDraft.data).toMatch(/is draft/);
		const twice = await tool("add_to_sent_po", {
			po: po.id,
			sku: "BLADE",
			quantity: 1,
		});
		expect(twice.data).toMatch(/already on PO .*adjust_sent_po_line/);
		const added = await tool("add_to_sent_po", {
			po: po.id,
			sku: "KNIFE",
			quantity: 3,
		});
		expect(added.data.lines).toContainEqual(
			expect.objectContaining({ sku: "KNIFE", quantity: 3, unitCost: 9 }),
		);

		const nothing = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "BLADE",
		});
		expect(nothing).toMatchObject({ isError: true });
		await tool("receive_po_line", { po: po.id, sku: "BLADE", quantity: 4 });
		const tooLow = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "BLADE",
			quantity: 3,
		});
		expect(tooLow.data).toMatch(/4 already arrived/);
		const adjusted = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "BLADE",
			quantity: 8,
			unit_cost: 2.5,
		});
		expect(adjusted.data.was).toEqual({ quantity: 10, unitCost: 2 });
		expect(adjusted.data.warning).toMatch(/old price/);
		expect(adjusted.data.po.lines).toContainEqual(
			expect.objectContaining({
				sku: "BLADE",
				quantity: 8,
				unitCost: 2.5,
				sent: { quantity: 10, unitCost: 2 },
			}),
		);

		// A line added after sending that never arrived comes off at 0.
		const gone = await tool("adjust_sent_po_line", {
			po: po.id,
			sku: "KNIFE",
			quantity: 0,
		});
		expect(gone.data.removed).toBe("KNIFE");
		expect(gone.data.po.lines.map((l: { sku: string }) => l.sku)).toEqual([
			"BLADE",
		]);
		const amendments = await db
			.select({ kind: schema.purchaseOrderAmendments.kind })
			.from(schema.purchaseOrderAmendments)
			.orderBy(schema.purchaseOrderAmendments.id);
		expect(amendments.map((a) => a.kind)).toEqual([
			"added",
			"quantity",
			"cost",
			"removed",
		]);
	});

	describe("supplier invoices", () => {
		let tsw: number;
		let po: number;
		beforeEach(async () => {
			[{ id: tsw }] = await db
				.insert(schema.suppliers)
				.values({ code: "TSW", name: "Tool Source Warehouse" })
				.returning();
			const box = await createProduct(db, "TT-EZ12TT", "simple");
			const flusher = await createProduct(db, "COL-DF25", "simple");
			const knife = await createProduct(db, "TT-TK8SSTT", "simple");
			await db
				.update(schema.products)
				// Variants need a product group; the name alone reads the same.
				.set({ name: 'Columbia Direct Corner Flusher (2.5")' })
				.where(eq(schema.products.id, flusher));
			for (const [productId, supplierSku] of [
				[blade, null],
				[box, "TTTEZ12TT"],
				[flusher, null],
				[knife, null],
			] as const)
				await db.insert(schema.productSuppliers).values({
					productId,
					supplierId: tsw,
					supplierSku,
					supplierCount: 1,
				});
			const [location] = await db.select().from(schema.locations);
			const [order] = await db
				.insert(schema.purchaseOrders)
				.values({ supplierId: tsw, locationId: location.id })
				.returning();
			po = order.id;
			await db.insert(schema.purchaseOrderLines).values([
				{
					purchaseOrderId: po,
					productId: box,
					supplierCount: 1,
					quantity: 15,
					unitCost: 284,
				},
				{
					purchaseOrderId: po,
					productId: flusher,
					supplierCount: 1,
					quantity: 10,
					unitCost: 76.37,
				},
				{
					purchaseOrderId: po,
					productId: knife,
					unit: "BOX",
					packSize: 10,
					supplierCount: 10,
					quantity: 2,
					unitCost: 67.2,
				},
				{
					purchaseOrderId: po,
					productId: blade,
					supplierCount: 1,
					quantity: 4,
					unitCost: 1.5,
				},
			]);
		});

		test("a PO reads with its totals and without images", async () => {
			const { data } = await tool("get_purchase_order", { id: po });
			expect(data.totals).toEqual({
				lines: 4,
				quantity: 31,
				items: 49,
				total: 5164.1,
				linesWithoutPrice: 0,
				received: 0,
			});
			expect(data.lines[0]).not.toHaveProperty("imageUrl");
			expect(data.invoices).toEqual([]);
		});

		test("matching reports each difference and changes nothing", async () => {
			const { data } = await tool("match_invoice", {
				po,
				invoice_number: "TSW-INV-1",
				total: 5467.1,
				lines: [
					{
						supplier_sku: "TTTEZ12TT",
						description: 'TapeTech Flat Box (12")',
						quantity: 16,
						unit_cost: 284,
					},
					{
						description: 'Columbia Direct Corner Flusher (2.5")',
						quantity: 10,
						unit_cost: 78.37,
					},
					{
						supplier_sku: "TTTK8",
						description: "TT-TK8SSTT",
						quantity: 2,
						unit_cost: 67.2,
					},
					{ description: "Something else", quantity: 1, unit_cost: 5 },
				],
			});
			expect(data.matches).toBe(false);
			expect(data.warning).toMatch(/still a draft/);
			expect(data.differences).toMatchObject([
				{
					line: 1,
					sku: "TT-EZ12TT",
					matchedBy: "supplier_sku",
					issues: ["quantity"],
					amountOver: 284,
				},
				{
					line: 2,
					sku: "COL-DF25",
					matchedBy: "description",
					issues: ["price"],
					amountOver: 20,
				},
			]);
			expect(data.notOnPo).toMatchObject([
				{ line: 4, reason: "not on the PO" },
			]);
			expect(data.notOnInvoice).toMatchObject([{ sku: "BLADE", quantity: 4 }]);
			expect(data.supplierSkusToSave).toEqual([
				{ sku: "TT-TK8SSTT", supplierSku: "TTTK8" },
			]);
			expect(data.totals).toMatchObject({
				matchingLines: 1,
				poTotal: 5164.1,
				invoiceLinesTotal: 5467.1,
				invoiceOverPo: 303,
				invoiceArithmeticOff: 0,
			});
			const [line] = await db
				.select()
				.from(schema.purchaseOrderLines)
				.where(eq(schema.purchaseOrderLines.unitCost, 284));
			expect(line.quantity).toBe(15);
		});

		test("a description that fits two lines matches neither", async () => {
			await db.update(schema.products).set({ name: "Same" });
			const { data } = await tool("match_invoice", {
				po,
				lines: [{ description: "Same", quantity: 1, unit_cost: 1 }],
			});
			expect(data.notOnPo[0].reason).toMatch(/^description fits /);
		});

		test("an invoice is kept once, only on a PO that's on order", async () => {
			const record = (number: string) =>
				tool("record_supplier_invoice", {
					po,
					number,
					invoiced_on: "2026-10-17",
					due_on: "2026-11-16",
					total: 5458.4,
				});
			expect((await record("TSW-INV-1")).data).toMatch(
				/is a draft, not on order/,
			);
			const sent = await tool("mark_po_sent", { po, sent_on: "2000-01-01" });
			expect(sent.data).toMatch(/was made on/);
			await tool("mark_po_sent", { po });
			const [order] = await db.select().from(schema.purchaseOrders);
			expect(order).toMatchObject({ status: "sent", sentTo: null });
			expect((await record("TSW-INV-1")).isError).toBe(false);
			expect((await record(" tsw-inv-1 ")).data).toMatch(
				/already recorded on PO/,
			);
			const { data } = await tool("get_purchase_order", { id: po });
			expect(data.invoices).toMatchObject([
				{
					number: "TSW-INV-1",
					invoicedOn: "2026-10-17",
					dueOn: "2026-11-16",
					total: 5458.4,
				},
			]);
			const again = await tool("match_invoice", {
				po,
				invoice_number: "TSW-INV-1",
				lines: [{ sku: "BLADE", quantity: 4, unit_cost: 1.5 }],
			});
			expect(again.data.alreadyRecorded).toMatch(/already recorded/);
			await tool("remove_supplier_invoice", { id: data.invoices[0].id });
			expect(await db.select().from(schema.supplierInvoices)).toEqual([]);
		});

		test("item numbers fill in only for that supplier's products, keeping others", async () => {
			const other = await createProduct(db, "ELSEWHERE", "simple");
			const [{ id: canam }] = await db
				.insert(schema.suppliers)
				.values({ code: "CANAM", name: "CanAm" })
				.returning();
			await db
				.insert(schema.productSuppliers)
				.values({ productId: other, supplierId: canam, supplierCount: 1 });
			const { data } = await tool("set_supplier_skus", {
				supplier: "tsw",
				items: [
					{ sku: "BLADE", supplier_sku: " BLD1 " },
					{ sku: "TT-EZ12TT", supplier_sku: "OTHER" },
					{ sku: "ELSEWHERE", supplier_sku: "X" },
					{ sku: "NOPE", supplier_sku: "Y" },
				],
			});
			expect(data).toEqual({
				filled: [{ sku: "BLADE", supplierSku: "BLD1", was: null }],
				unchanged: [],
				kept: [{ sku: "TT-EZ12TT", ours: "TTTEZ12TT", given: "OTHER" }],
				skipped: [
					{ sku: "NOPE", reason: "no such SKU" },
					{ sku: "ELSEWHERE", reason: "bought from another supplier" },
				],
			});
		});
	});
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
