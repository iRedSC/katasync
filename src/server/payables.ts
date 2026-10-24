import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { requireActor } from "#/audit/context";
import { getDb } from "#/db/client";
import { paymentMethods } from "#/db/payables-schema";
import {
	applyCredit,
	assertOpeningHistory,
	orderPayables,
	recordPayment,
	reversePayment,
	unapplyPayment,
	withdrawOpeningHistory,
} from "#/purchasing/payables";

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
	.handler(async ({ data }) => recordPayment(getDb(), data, requireActor()));

export const applySupplierCredit = createServerFn({ method: "POST" })
	.validator(
		type({
			id: uuid,
			paymentId: uuid,
			invoiceId: "number.integer > 0",
			amountCents: cents,
		}),
	)
	.handler(async ({ data }) => applyCredit(getDb(), data, requireActor()));

export const unapplySupplierPayment = createServerFn({ method: "POST" })
	.validator(type({ applicationId: uuid }))
	.handler(async ({ data }) => unapplyPayment(getDb(), data, requireActor()));

export const reverseSupplierPayment = createServerFn({ method: "POST" })
	.validator(type({ paymentId: uuid, "reason?": "string | null" }))
	.handler(async ({ data }) => reversePayment(getDb(), data, requireActor()));

export const assertInvoiceHistory = createServerFn({ method: "POST" })
	.validator(
		type({
			invoiceId: "number.integer > 0",
			paidCents: "number.integer >= 0",
			"note?": "string | null",
		}),
	)
	.handler(async ({ data }) =>
		assertOpeningHistory(getDb(), data, requireActor()),
	);

export const withdrawInvoiceHistory = createServerFn({ method: "POST" })
	.validator(type({ invoiceId: "number.integer > 0" }))
	.handler(async ({ data }) =>
		withdrawOpeningHistory(getDb(), data, requireActor()),
	);
