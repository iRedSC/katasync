import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import { paymentMethods } from "#/db/payables-schema";
import { restoreInvoice, voidInvoice } from "#/purchasing/invoices";
import type { StaffContext } from "#/purchasing/invoice-matching";
import {
	orderPayables,
	recordPayment,
	reversePayment,
} from "#/purchasing/payables";
import { json, READ, WRITE } from "./tool-shapes";

async function payablesFor(db: Db, po: number) {
	const { billing, payments, unappliedCents } = await orderPayables(db, po);
	return {
		invoices: billing.invoices.map((i) => ({
			id: i.id,
			number: i.number,
			totalCents: i.totalCents,
			match: i.match,
			payment: i.payment,
			voided: i.voided !== null,
		})),
		billedVsReceived: billing.lines,
		payments,
		unappliedCents,
	};
}

export function registerInvoiceTools(
	server: McpServer,
	db: Db,
	ctx: StaffContext = {},
) {
	server.registerTool(
		"po_payables",
		{
			description:
				"A PO's invoices checked against what was received (net of receipt undos, earlier invoices first), each one's payment state, and the supplier's payments touching them. Matched invoices bill only received, unbilled units at the PO's price; exceptions list why. Invoices recorded before lines were kept are unverified and their earlier payments unknown. Payments are records staff entered, not bank-confirmed.",
			inputSchema: { po: z.number().int().positive() },
			annotations: READ,
		},
		async ({ po }) => json(await payablesFor(db, po)),
	);

	server.registerTool(
		"void_supplier_invoice",
		{
			description:
				"Voids a recorded invoice instead of deleting it: its number stays taken, payments applied to it become the supplier's unapplied credit, and restore_supplier_invoice brings it back as it was.",
			inputSchema: {
				id: z.number().int().positive(),
				reason: z.string().optional(),
			},
			annotations: WRITE,
		},
		async ({ id, reason }) => json(await voidInvoice(db, { id, reason }, ctx)),
	);

	server.registerTool(
		"restore_supplier_invoice",
		{
			description:
				"Puts a voided invoice back, same id and number. Payments taken off by voiding stay unapplied credit.",
			inputSchema: { id: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ id }) => json(await restoreInvoice(db, { id }, ctx)),
	);

	server.registerTool(
		"record_supplier_payment",
		{
			description:
				"Writes down a payment staff already made to a supplier. It moves no money and contacts no one. Ask the user first. Applies it to invoices up to their open balance; the rest is unapplied credit. Retrying with the same payment_id is safe.",
			inputSchema: {
				payment_id: z.string().uuid().optional(),
				supplier_id: z.number().int().positive(),
				amount_cents: z.number().int().positive(),
				paid_on: z.string().describe("YYYY-MM-DD"),
				method: z.enum(paymentMethods),
				reference: z.string().optional(),
				apply: z
					.array(
						z.object({
							invoice_id: z.number().int().positive(),
							amount_cents: z.number().int().positive(),
						}),
					)
					.optional(),
			},
			annotations: WRITE,
		},
		async (input) =>
			json(
				await recordPayment(
					db,
					{
						id: input.payment_id ?? randomUUID(),
						supplierId: input.supplier_id,
						amountCents: input.amount_cents,
						paidOn: input.paid_on,
						method: input.method,
						reference: input.reference,
						applications: (input.apply ?? []).map((a) => ({
							id: randomUUID(),
							invoiceId: a.invoice_id,
							amountCents: a.amount_cents,
						})),
					},
					ctx,
				),
			),
	);

	server.registerTool(
		"reverse_supplier_payment",
		{
			description:
				"Marks a recorded payment as not having happened (e.g. entered twice). It stays visible as reversed and its invoice applications come off. Moves no money.",
			inputSchema: {
				payment_id: z.string().uuid(),
				reason: z.string().optional(),
			},
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ payment_id, reason }) =>
			json(await reversePayment(db, { paymentId: payment_id, reason }, ctx)),
	);
}
