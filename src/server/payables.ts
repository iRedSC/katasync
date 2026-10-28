import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { requireActor } from "#/audit/context";
import { getDb } from "#/db/client";
import { paymentMethods } from "#/db/payables-schema";
import { answer } from "#/lib/answer";
import { MoneyError } from "#/purchasing/invoice-matching";
import { PurchaseOrderError } from "#/purchasing/orders";
import {
	applyCredit,
	assertOpeningHistory,
	orderPayables,
	recordPayment,
	reversePayment,
	unapplyPayment,
	withdrawOpeningHistory,
} from "#/purchasing/payables";

// What the payables rules say no with; staff fix what they typed and try
// again, rather than resending the same.
const refusals = [PurchaseOrderError, MoneyError];

const uuid = "string.uuid";
const cents = "number.integer > 0";

export const getOrderPayables = createServerFn({ method: "GET" })
	.validator(type({ purchaseOrderId: "number.integer > 0" }))
	.handler(async ({ data }) => orderPayables(getDb(), data.purchaseOrderId));

export const recordSupplierPayment = createServerFn({ method: "POST" })
	.validator(
		type({
			id: uuid,
			supplierId: "number.integer > 0",
			amountCents: cents,
			"currency?": "'USD'",
			paidOn: "string",
			method: type.enumerated(...paymentMethods),
			"reference?": "string | null",
			"applications?": type({
				id: uuid,
				invoiceId: "number.integer > 0",
				amountCents: cents,
			}).array(),
		}),
	)
	.handler(async ({ data }) =>
		answer(refusals, () => recordPayment(getDb(), data, requireActor())),
	);

export const applySupplierCredit = createServerFn({ method: "POST" })
	.validator(
		type({
			id: uuid,
			paymentId: uuid,
			invoiceId: "number.integer > 0",
			amountCents: cents,
		}),
	)
	.handler(async ({ data }) =>
		answer(refusals, () => applyCredit(getDb(), data, requireActor())),
	);

export const unapplySupplierPayment = createServerFn({ method: "POST" })
	.validator(type({ applicationId: uuid }))
	.handler(async ({ data }) =>
		answer(refusals, () => unapplyPayment(getDb(), data, requireActor())),
	);

export const reverseSupplierPayment = createServerFn({ method: "POST" })
	.validator(type({ paymentId: uuid, "reason?": "string | null" }))
	.handler(async ({ data }) =>
		answer(refusals, () => reversePayment(getDb(), data, requireActor())),
	);

export const assertInvoiceHistory = createServerFn({ method: "POST" })
	.validator(
		type({
			invoiceId: "number.integer > 0",
			paidCents: "number.integer >= 0",
			"note?": "string | null",
		}),
	)
	.handler(async ({ data }) =>
		answer(refusals, () => assertOpeningHistory(getDb(), data, requireActor())),
	);

export const withdrawInvoiceHistory = createServerFn({ method: "POST" })
	.validator(type({ invoiceId: "number.integer > 0" }))
	.handler(async ({ data }) =>
		withdrawOpeningHistory(getDb(), data, requireActor()),
	);
