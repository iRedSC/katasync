import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { checkApiToken, createApiToken, revokeApiToken } from "#/auth/tokens";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { createProduct, createTestDb } from "#/test/db";
import { logCalls } from "./log";
import { describeSchema, readOnlyQuery } from "./query";
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
	test("return rows and say when they were cut off", async () => {
		await createProduct(db, "KNIFE", "simple");
		const all = await readOnlyQuery(
			db,
			"select sku from products order by sku;",
		);
		expect(all).toEqual({
			rows: [{ sku: "BLADE" }, { sku: "KNIFE" }],
			truncated: false,
		});
		const one = await readOnlyQuery(
			db,
			"select sku from products -- comment",
			1,
		);
		expect(one.truncated).toBe(true);
	});

	test("can't write, even smuggled after the select", async () => {
		await expect(
			readOnlyQuery(db, "delete from products returning *"),
		).rejects.toThrow();
		await expect(
			readOnlyQuery(
				db,
				"select 1) q; delete from products; select * from (select 1",
			),
		).rejects.toThrow();
		await expect(
			readOnlyQuery(
				db,
				"with gone as (delete from products returning *) select * from gone",
			),
		).rejects.toThrow();
		expect(await db.select().from(schema.products)).toHaveLength(1);
	});

	test("the schema lists tables and views but not sign-in bookkeeping", async () => {
		const tables = await describeSchema(db);
		expect(tables.products.kind).toBe("table");
		expect(tables.owned_stock.kind).toBe("view");
		expect(tables.sales_units.columns).toContain("units integer");
		expect(tables.sessions).toBeUndefined();
	});
});

test("API tokens work until revoked, and only their hash is kept", async () => {
	const token = await createApiToken(db, " Claude ");
	expect(token).toMatch(/^ks_/);
	const row = await checkApiToken(db, token);
	expect(row?.name).toBe("Claude");
	expect(row?.tokenHash).not.toBe(token);
	expect(await checkApiToken(db, "ks_made-up")).toBeNull();
	expect(await checkApiToken(db, token.slice(3))).toBeNull();
	await revokeApiToken(db, row?.tokenHash ?? "");
	expect(await checkApiToken(db, token)).toBeNull();
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
