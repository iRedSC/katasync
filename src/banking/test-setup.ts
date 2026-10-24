import { eq } from "drizzle-orm";
import { systemActor } from "#/auth/actor";
import type { BankCsvMapping } from "#/db/banking-schema";
import { bankTransactions } from "#/db/banking-schema";
import type { Db } from "#/db/client";
import { payouts } from "#/db/schema";
import { createAccount } from "./accounts";
import { commitImport } from "./imports";

export const MAPPING: BankCsvMapping = {
	date: "Date",
	dateFormat: "ymd",
	description: "Description",
	amount: { kind: "signed", column: "Amount", positiveMeans: "in" },
	bankId: null,
	currency: null,
};

export const csv = (...lines: string[]) =>
	["Date,Description,Amount", ...lines].join("\n");

export async function account(db: Db, name = "Operating", currency = "USD") {
	const r = await createAccount(db, { name, currency }, testActor);
	if (!r.ok) throw new Error(r.problem);
	return r.value;
}

export async function imported(
	db: Db,
	accountId: number,
	text: string,
	mapping = MAPPING,
) {
	const r = await commitImport(
		db,
		{
			accountId,
			text,
			fileName: "statement.csv",
			mapping,
			skipRows: [],
		},
		testActor,
	);
	if (!r.ok) throw new Error(r.problem);
	return r.value;
}

export async function bankRows(db: Db, accountId: number) {
	return db
		.select()
		.from(bankTransactions)
		.where(eq(bankTransactions.accountId, accountId))
		.orderBy(bankTransactions.id);
}

export async function payout(
	db: Db,
	externalId: string,
	amount: number,
	more: Partial<typeof payouts.$inferInsert> = {},
) {
	const [row] = await db
		.insert(payouts)
		.values({
			channel: "shopify",
			externalId,
			status: "sent",
			depositedAt: new Date("2026-10-01T15:00:00Z"),
			amount,
			currency: "USD",
			...more,
		})
		.returning({ id: payouts.id });
	return row.id;
}

export const part = (id: number, amountCents: number) => ({
	target: { kind: "payout" as const, id },
	amountCents,
});

const testActor = systemActor("script");
