import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import { raiseFlag, reopenFlag, resolveFlag } from "./flags";
import { fileEmail, setAside } from "./inbox/ingest";
import { orderAgain } from "./orders";
import { carry, createPurchasingDb } from "./purchasing.fixtures";

// PGlite has one connection, so a deadlock or race can't be staged. These
// pin the order rows are locked in, which keeps them from happening: a PO
// before its flags and products, and an email before what's checked on it.

let db: Db;
let canam: number;
let warehouse: number;
let blade: number;

beforeEach(async () => {
	({ db, canam, warehouse } = await createPurchasingDb());
	[{ id: blade }] = await db
		.insert(schema.products)
		.values({ sku: "BLADE", name: "Blade", kind: "simple" })
		.returning();
});

async function order(status: "sent" | "closed") {
	const [{ id }] = await db
		.insert(schema.purchaseOrders)
		.values({
			supplierId: canam,
			locationId: warehouse,
			status,
			sentAt: new Date(),
		})
		.returning();
	await db.insert(schema.purchaseOrderLines).values({
		purchaseOrderId: id,
		productId: blade,
		supplierCount: 1,
		quantity: 5,
		unitCost: 10,
		sentQuantity: 5,
		sentUnitCost: 10,
	});
	return id;
}

// The rows each statement locks, in order: its table, and its parameters.
function logged() {
	const locks: { table: string; params: unknown[] }[] = [];
	const logging = drizzle((db as unknown as { $client: PGlite }).$client, {
		schema,
		casing: "snake_case",
		logger: {
			logQuery: (query, params) => {
				const table = /for update$/.test(query)
					? /from "(\w+)"/.exec(query)?.[1]
					: undefined;
				if (table) locks.push({ table, params });
			},
		},
	}) as unknown as Db;
	return { logging, locks };
}

describe("lock order", () => {
	test("ordering again locks both POs in one statement, then products", async () => {
		await carry(db, blade, canam);
		const source = await order("closed");
		const { logging, locks } = logged();
		const { id: draft } = await orderAgain(logging, source);
		const last = locks.map((l) => l.table).lastIndexOf("purchase_orders");
		expect(locks[last].params).toEqual(expect.arrayContaining([source, draft]));
		expect(locks.slice(last + 1).map((l) => l.table)).toContain("products");
	});

	test("reopening a flag locks its PO first, and keeps a newer edit", async () => {
		const po = await order("sent");
		const flag = await raiseFlag(db, {
			purchaseOrderId: po,
			by: "claude",
			flag: { kind: "price", sku: "BLADE", value: 12, note: "Now $12" },
		});
		await resolveFlag(db, { id: flag.id, apply: true });
		await db.update(schema.purchaseOrderLines).set({ unitCost: 14 });
		const { logging, locks } = logged();
		await expect(reopenFlag(logging, flag.id)).rejects.toThrow(/changed since/);
		expect(locks.map((l) => l.table).slice(0, 2)).toEqual([
			"purchase_orders",
			"po_flags",
		]);
		const [line] = await db.select().from(schema.purchaseOrderLines);
		expect(line.unitCost).toBe(14);
	});

	test("an email is filed or set aside, never both", async () => {
		const po = await order("sent");
		const email = async (messageId: string) =>
			(
				await db
					.insert(schema.poEmails)
					.values({
						messageId,
						fromAddress: "rep@canam.com",
						recipients: ["purchasing@eastcoastdrywall.com"],
						subject: "Shipped",
						body: "",
						receivedAt: new Date(),
					})
					.returning()
			)[0].id;
		const filed = await email("<filed@canam.com>");
		await fileEmail(db, { emailId: filed, purchaseOrderId: po, by: "staff" });
		const { logging, locks } = logged();
		await expect(setAside(logging, filed)).rejects.toThrow(/take it off/);
		expect(locks.map((l) => l.table)).toEqual(["po_emails"]);

		const aside = await email("<aside@canam.com>");
		await setAside(db, aside);
		await expect(
			fileEmail(db, {
				emailId: aside,
				purchaseOrderId: po,
				by: "ai",
				onlyFrom: null,
			}),
		).rejects.toThrow(/set it aside first/);
		const rows = await db
			.select()
			.from(schema.poEmails)
			.where(eq(schema.poEmails.purchaseOrderId, po));
		expect(rows.map((r) => [r.id, r.setAsideAt])).toEqual([[filed, null]]);
	});
});
