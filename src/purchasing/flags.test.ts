import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "#/db/client";
import * as schema from "#/db/schema";
import {
	openFlagsOf,
	raiseFlag,
	reopenFlag,
	resolveFlag,
} from "#/purchasing/flags";
import { createPurchasingDb } from "#/purchasing/purchasing.fixtures";

describe("flags", () => {
	let db: Db;
	let po: number;
	beforeEach(async () => {
		const made = await createPurchasingDb();
		db = made.db;
		const [p] = await db
			.insert(schema.products)
			.values({ sku: "BLADE", name: "Blade", kind: "simple" })
			.returning();
		[{ id: po }] = await db
			.insert(schema.purchaseOrders)
			.values({
				supplierId: made.canam,
				locationId: made.warehouse,
				status: "sent",
				sentAt: new Date(),
			})
			.returning();
		await db.insert(schema.purchaseOrderLines).values({
			purchaseOrderId: po,
			productId: p.id,
			supplierCount: 1,
			quantity: 5,
			unitCost: 10,
			sentQuantity: 5,
			sentUnitCost: 10,
		});
	});
	const line = async () =>
		(await db.select().from(schema.purchaseOrderLines))[0];
	const raise = (flag: Parameters<typeof raiseFlag>[1]["flag"]) =>
		raiseFlag(db, { purchaseOrderId: po, by: "claude", flag });

	test("apply makes the change; reopen sets it back", async () => {
		const f = await raise({
			kind: "price",
			sku: "BLADE",
			value: 12,
			note: "x",
		});
		expect(await openFlagsOf(db, po)).toMatchObject([
			{ sku: "BLADE", unitCost: 10, value: 12 },
		]);
		await resolveFlag(db, { id: f.id, apply: true });
		expect((await line()).unitCost).toBe(12);
		expect(await openFlagsOf(db, po)).toEqual([]);
		await expect(resolveFlag(db, { id: f.id, apply: true })).rejects.toThrow(
			/applied already/,
		);
		await reopenFlag(db, f.id);
		expect((await line()).unitCost).toBe(10);
		expect(await openFlagsOf(db, po)).toHaveLength(1);
	});

	test("quantity and back-order apply too", async () => {
		const q = await raise({
			kind: "quantity",
			sku: "BLADE",
			value: 4,
			note: "x",
		});
		const b = await raise({ kind: "back_order", sku: "BLADE", note: "x" });
		await resolveFlag(db, { id: q.id, apply: true });
		await resolveFlag(db, { id: b.id, apply: true });
		expect(await line()).toMatchObject({ quantity: 4 });
		expect((await line()).backOrderedAt).not.toBeNull();
		await reopenFlag(db, b.id);
		expect((await line()).backOrderedAt).toBeNull();
	});

	test("a newer flag of a kind replaces the open one; notes add up", async () => {
		await raise({ kind: "price", sku: "BLADE", value: 12, note: "x" });
		await raise({ kind: "price", sku: "blade", value: 13, note: "y" });
		await raise({ kind: "note", sku: null, note: "Substituting" });
		await raise({ kind: "note", sku: null, note: "Call us" });
		expect(await openFlagsOf(db, po)).toMatchObject([
			{ kind: "price", value: 13, note: "y" },
			{ kind: "note" },
			{ kind: "note" },
		]);
	});

	test("refuses a flag the PO can't take, and a reopen over a newer change", async () => {
		await expect(
			raise({ kind: "back_order", sku: "", note: "x" }),
		).rejects.toThrow(/needs the line's sku/);
		await expect(
			raise({ kind: "quantity", sku: "BLADE", value: 1.5, note: "x" }),
		).rejects.toThrow(/can't be 1.5/);
		await expect(
			raise({ kind: "price", sku: "BLADE", value: 1e9, note: "x" }),
		).rejects.toThrow(/can't be 1000000000/);
		const n = await raise({ kind: "note", sku: null, note: "x" });
		await expect(resolveFlag(db, { id: n.id, apply: true })).rejects.toThrow(
			/nothing to apply/,
		);
		const f = await raise({
			kind: "price",
			sku: "BLADE",
			value: 12,
			note: "x",
		});
		await resolveFlag(db, { id: f.id, apply: true });
		await db.update(schema.purchaseOrderLines).set({ unitCost: 14 });
		await expect(reopenFlag(db, f.id)).rejects.toThrow(/changed since/);
		expect((await line()).unitCost).toBe(14);
	});
});
