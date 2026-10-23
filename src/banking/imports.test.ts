import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	bankAccounts,
	bankImportRows,
	bankTransactions,
} from "#/db/banking-schema";
import { createTestDb } from "#/test/db";
import { createAccount } from "./accounts";
import { commitImport, previewImport } from "./imports";
import { account, bankRows, csv, imported, MAPPING } from "./test-setup";

describe("bank CSV import", () => {
	it("imports the same file into the same account once", async () => {
		const db = await createTestDb();
		const a = await account(db);
		const text = csv("2026-10-01,Shopify,100.00", "2026-10-02,Fee,-1.50");
		const first = await imported(db, a.id, text);
		const again = await imported(db, a.id, text);
		expect(first).toMatchObject({ kind: "imported", added: 2 });
		expect(again).toEqual({
			kind: "already",
			importId: first.kind === "imported" ? first.importId : -1,
		});
		expect(await bankRows(db, a.id)).toHaveLength(2);
		const other = await account(db, "Savings");
		expect(await imported(db, other.id, text)).toMatchObject({
			kind: "imported",
			added: 2,
		});
	});

	it("keeps identical rows without bank IDs, and flags rows another import already has", async () => {
		const db = await createTestDb();
		const a = await account(db);
		await imported(
			db,
			a.id,
			csv("2026-10-01,Fee,-5.00", "2026-10-01,Fee,-5.00"),
		);
		expect(await bankRows(db, a.id)).toHaveLength(2);
		const overlap = csv(
			"2026-10-01,Fee,-5.00",
			"2026-10-01,Fee,-5.00",
			"2026-10-01,Fee,-5.00",
			"2026-10-03,New,1",
		);
		const p = await previewImport(db, {
			accountId: a.id,
			text: overlap,
			fileName: null,
			mapping: MAPPING,
		});
		if (!p.ok) throw new Error(p.problem);
		expect(
			p.value.rows.map((r) => r.kind === "accepted" && r.repeatOf !== null),
		).toEqual([true, true, false, false]);
		const r = await commitImport(db, {
			accountId: a.id,
			text: overlap,
			fileName: null,
			mapping: MAPPING,
			skipRows: [1, 2],
		});
		expect(r).toMatchObject({
			ok: true,
			value: { kind: "imported", added: 2, skipped: 2 },
		});
		expect(await bankRows(db, a.id)).toHaveLength(4);
		const outcomes = await db
			.select({ outcome: bankImportRows.outcome })
			.from(bankImportRows)
			.orderBy(bankImportRows.id);
		expect(outcomes.map((o) => o.outcome)).toEqual([
			"accepted",
			"accepted",
			"skipped",
			"skipped",
			"accepted",
			"accepted",
		]);
	});

	it("takes a bank ID once per account, and refuses one that comes back different", async () => {
		const db = await createTestDb();
		const a = await account(db);
		const mapping = { ...MAPPING, bankId: "Id" };
		await imported(
			db,
			a.id,
			"Date,Description,Amount,Id\n2026-10-01,A,10,T1\n2026-10-02,B,20,T2",
			mapping,
		);
		const r = await imported(
			db,
			a.id,
			"Date,Description,Amount,Id\n2026-10-01,A,10,T1\n2026-10-02,B,21,T2\n2026-10-03,C,30,T3",
			mapping,
		);
		expect(r).toMatchObject({
			kind: "imported",
			added: 1,
			duplicates: 1,
			invalid: 1,
		});
		const rows = await db
			.select()
			.from(bankImportRows)
			.where(eq(bankImportRows.outcome, "invalid"));
		expect(rows[0]).toMatchObject({
			rowNumber: 2,
			cells: ["2026-10-02", "B", "21", "T2"],
			problem: expect.stringContaining("T2"),
		});
	});

	it("writes nothing when the commit is refused", async () => {
		const db = await createTestDb();
		const a = await account(db);
		const text = csv("2026-10-01,A,1", "bad,B,2");
		const r = await commitImport(db, {
			accountId: a.id,
			text,
			fileName: null,
			mapping: MAPPING,
			skipRows: [2],
		});
		expect(r.ok).toBe(false);
		expect(await db.select().from(bankImportRows)).toHaveLength(0);
		const wrong = await commitImport(db, {
			accountId: a.id,
			text,
			fileName: null,
			mapping: { ...MAPPING, date: "When" },
			skipRows: [],
		});
		expect(wrong).toEqual({
			ok: false,
			problem: expect.stringContaining("When"),
		});
	});

	it("keeps import evidence and an account's currency as they were", async () => {
		const db = await createTestDb();
		const a = await account(db);
		await imported(db, a.id, csv("2026-10-01,A,1"));
		await expect(
			db.update(bankTransactions).set({ amountCents: 2 }),
		).rejects.toThrow();
		await expect(db.delete(bankImportRows)).rejects.toThrow();
		await expect(
			db.update(bankAccounts).set({ currency: "CAD" }),
		).rejects.toThrow();
		await expect(
			db.execute(sql`update bank_accounts set name = 'Main'`),
		).resolves.toBeDefined();
	});

	it("refuses currencies it can't keep in cents, and repeated names", async () => {
		const db = await createTestDb();
		expect(
			await createAccount(db, { name: "Yen", currency: "JPY" }),
		).toMatchObject({ ok: false });
		await account(db, "Main");
		expect(
			await createAccount(db, { name: " Main ", currency: "USD" }),
		).toMatchObject({ ok: false });
	});
});
