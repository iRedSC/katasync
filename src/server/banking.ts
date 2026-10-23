import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { createAccount } from "#/banking/accounts";
import { LIMITS } from "#/banking/csv";
import { peekFile } from "#/banking/guess";
import { commitImport, previewImport } from "#/banking/imports";
import { mappingInput } from "#/banking/mapping";
import { confirmMatch, undoMatch } from "#/banking/matching";
import { loadOverview, matchOptions } from "#/banking/overview";
import { getDb } from "#/db/client";

const id = "number.integer > 0";

const importInput = type({
	accountId: id,
	text: `string <= ${LIMITS.fileBytes}`,
	fileName: "(string <= 200) | null",
	mapping: mappingInput,
});

const part = type({
	target: { kind: "'payout'", id },
	amountCents: "number.integer",
});

export const getReconciliation = createServerFn()
	.validator(type({ "accountId?": id }))
	.handler(async ({ data }) => loadOverview(getDb(), data.accountId ?? null));

export type Reconciliation = Awaited<ReturnType<typeof getReconciliation>>;

export const newBankAccount = createServerFn({ method: "POST" })
	.validator(type({ name: "string <= 200", currency: "string <= 10" }))
	.handler(async ({ data }) => createAccount(getDb(), data));

export const peekBankFile = createServerFn({ method: "POST" })
	.validator(type({ text: `string <= ${LIMITS.fileBytes}` }))
	.handler(async ({ data }) => peekFile(data.text));

export const previewBankFile = createServerFn({ method: "POST" })
	.validator(importInput)
	.handler(async ({ data }) => previewImport(getDb(), data));

export type BankFilePreview = Awaited<ReturnType<typeof previewBankFile>>;

export const importBankFile = createServerFn({ method: "POST" })
	.validator(
		importInput.and({
			skipRows: type("number.integer > 0").array().atMostLength(LIMITS.rows),
		}),
	)
	.handler(async ({ data }) => commitImport(getDb(), data));

export const getMatchOptions = createServerFn()
	.validator(type({ transactionId: id }))
	.handler(async ({ data }) => matchOptions(getDb(), data.transactionId));

export type BankMatchOptions = NonNullable<Awaited<ReturnType<typeof getMatchOptions>>>;

export const matchBankRow = createServerFn({ method: "POST" })
	.validator(
		type({
			transactionId: id,
			parts: part.array().atLeastLength(1).atMostLength(20),
			replaces: type(id).or("null"),
		}),
	)
	.handler(async ({ data }) => confirmMatch(getDb(), data));

export const undoBankMatch = createServerFn({ method: "POST" })
	.validator(type({ matchId: id }))
	.handler(async ({ data }) => undoMatch(getDb(), data.matchId));
