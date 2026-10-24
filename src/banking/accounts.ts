import { asc, eq, sql } from "drizzle-orm";
import { recordedBy } from "#/audit/recorded-by";
import type { Actor } from "#/auth/actor";
import { bankAccounts } from "#/db/banking-schema";
import type { Db } from "#/db/client";
import { type Currency, type Parsed, parseCurrency } from "./money";

export type Account = { id: number; name: string; currency: Currency };

export type AccountView = { id: number; name: string; currency: string };

export const viewOf = (a: Account): AccountView => ({
	id: a.id,
	name: a.name,
	currency: a.currency,
});

type Reader = Pick<Db, "select">;

const toAccount = (row: typeof bankAccounts.$inferSelect): Account => {
	const currency = parseCurrency(row.currency);
	if (!currency.ok)
		throw new Error(`Bank account ${row.name}: ${currency.problem}`);
	return { id: row.id, name: row.name, currency: currency.value };
};

export async function listAccounts(db: Reader): Promise<Account[]> {
	const rows = await db
		.select()
		.from(bankAccounts)
		.orderBy(asc(bankAccounts.name));
	return rows.map(toAccount);
}

export async function loadAccount(
	db: Db,
	id: number,
	{ lock = false } = {},
): Promise<Account | null> {
	const query = db.select().from(bankAccounts).where(eq(bankAccounts.id, id));
	const [row] = lock
		? await db
				.update(bankAccounts)
				.set({ name: sql`${bankAccounts.name}` })
				.where(eq(bankAccounts.id, id))
				.returning()
		: await query;
	return row ? toAccount(row) : null;
}

export async function createAccount(
	db: Db,
	input: { name: string; currency: string },
	actor: Actor,
): Promise<Parsed<AccountView>> {
	const name = input.name.trim().replace(/\s+/g, " ");
	if (name.length === 0) return { ok: false, problem: "Name it" };
	if (name.length > 80) return { ok: false, problem: "Name is too long" };
	const currency = parseCurrency(input.currency);
	if (!currency.ok) return currency;
	const [row] = await db
		.insert(bankAccounts)
		.values({ name, currency: currency.value, createdBy: recordedBy(actor) })
		.onConflictDoNothing({ target: bankAccounts.name })
		.returning();
	if (!row) return { ok: false, problem: `"${name}" already exists` };
	return { ok: true, value: viewOf(toAccount(row)) };
}
