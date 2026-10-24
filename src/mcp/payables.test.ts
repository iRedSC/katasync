import { beforeEach, expect, test } from "vitest";
import type { Db } from "#/db/client";
import { supplierPayments } from "#/db/payables-schema";
import * as schema from "#/db/schema";
import { callMcp, callTool, freshDb } from "./mcp.fixtures";

let db: Db;
let supplierId: number;
let po: number;

beforeEach(async () => {
	({ db } = await freshDb());
	[{ id: supplierId }] = await db
		.insert(schema.suppliers)
		.values({ code: "PAY", name: "Supplier" })
		.returning();
	const [location] = await db.select().from(schema.locations);
	[{ id: po }] = await db
		.insert(schema.purchaseOrders)
		.values({ supplierId, locationId: location.id, status: "sent" })
		.returning();
});

test("read-only connectors can read payables but cannot record money evidence", async () => {
	const { tools } = await callMcp(db, false, "tools/list");
	const names = tools.map((tool: { name: string }) => tool.name);
	expect(names).toContain("po_payables");
	expect(names).not.toContain("record_supplier_payment");
	expect(names).not.toContain("void_supplier_invoice");
	expect((await callTool(db, false, "po_payables", { po })).isError).toBe(
		false,
	);
});

test("a write with no actor context fails without manufacturing provenance", async () => {
	const result = await callMcp(
		db,
		true,
		"tools/call",
		{
			name: "record_supplier_payment",
			arguments: {
				payment_id: "00000000-0000-4000-8000-000000000001",
				supplier_id: supplierId,
				amount_cents: 100,
				paid_on: "2026-10-24",
				method: "ach",
			},
		},
		null,
	);
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toMatch(/Signed out/);
	expect(await db.select().from(supplierPayments)).toEqual([]);
});

test("payment retries require an explicit stable identity and preserve actor provenance", async () => {
	const input = {
		supplier_id: supplierId,
		amount_cents: 100,
		paid_on: "2026-10-24",
		method: "ach",
	};
	expect(
		(await callTool(db, true, "record_supplier_payment", input)).isError,
	).toBe(true);
	const identified = {
		...input,
		payment_id: "00000000-0000-4000-8000-000000000002",
	};
	expect(
		(await callTool(db, true, "record_supplier_payment", identified)).isError,
	).toBe(false);
	expect(
		(await callTool(db, true, "record_supplier_payment", identified)).isError,
	).toBe(false);
	expect(await db.select().from(supplierPayments)).toMatchObject([
		{ recordedBy: "system:script", amountCents: 100 },
	]);
});
