import { asc, eq } from "drizzle-orm";
import { bankAccounts } from "#/db/banking-schema";
import type { Db } from "#/db/client";
import { type Currency, type Parsed, parseCurrency } from "./money";

export type Account = { id: number; name: string; currency: Currency };

type Reader = Pick<Db, "select">;

const toAccount = (row: typeof bankAccounts.$inferSelect): Account => {
	const currency = parseCurrency(row.currency);
	if (!currency.ok) throw new Error(`Bank account ${row.name}: ${currency.problem}`);
	return { id: row.id, name: row.name, currency: currency.value };
};

export async function listAccounts(db: Reader): Promise<Account[]> {
	const rows = await db.select().from(bankAccounts).orderBy(asc(bankAccounts.name));
	return rows.map(toAccount);
}

export async function loadAccount(
	db: Reader,
	id: number,
	{ lock = false } = {},
): Promise<Account | null> {
	const query = db.select().from(bankAccounts).where(eq(bankAccounts.id, id));
	const [row] = lock ? await query.for("update") : await query;
	return row ? toAccount(row) : null;
}

export async function createAccount(
	db: Db,
	input: { name: string; currency: string },
): Promise<Parsed<Account>> {
	const name = input.name.trim().replace(/\s+/g, " ");
	if (name.length === 0) return { ok: false, problem: "Name it" };
	if (name.length > 80) return { ok: false, problem: "Name is too long" };
	const currency = parseCurrency(input.currency);
	if (!currency.ok) return currency;
	const [row] = await db
		.insert(bankAccounts)
		.values({ name, currency: currency.value })
		.onConflictDoNothing({ target: bankAccounts.name })
		.returning();
	if (!row) return { ok: false, problem: `"${name}" already exists` };
	return { ok: true, value: toAccount(row) };
}
