import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { inArray } from "drizzle-orm";
import { requireActor } from "#/audit/context";
import { getDb } from "#/db/client";
import { products } from "#/db/schema";
import { billingOf } from "#/purchasing/invoice-ledger";
import type { InvoiceLine } from "#/purchasing/invoice-lines";
import { centsOf } from "#/purchasing/invoice-matching";
import { draftMatchable, evidenceOf } from "#/purchasing/invoice-records";
import {
	matchInvoice,
	recordInvoice,
	restoreInvoice,
	voidInvoice,
} from "#/purchasing/invoices";
import { loadOrder } from "#/purchasing/load";
import { fillSupplierSkus } from "#/purchasing/suppliers";
import { id } from "./id-input";

const invoiceLine = type({
	line: "number.integer > 0",
	"sku?": "string",
	"supplierSku?": "string",
	"description?": "string",
	quantity: "number.integer >= 0",
	unitCost: "number >= 0",
	"unit?": "string > 0",
	"packSize?": "number.integer > 0",
	"amount?": "number >= 0",
});

const linesOf = (
	lines: (typeof invoiceLine.infer)[],
	credits: number | undefined,
): InvoiceLine[] => [
	...lines.map((l) => ({ kind: "merchandise" as const, ...l })),
	...(credits
		? [
				{
					kind: "credit" as const,
					line: Math.max(0, ...lines.map((l) => l.line)) + 1,
					amount: credits,
				},
			]
		: []),
];

export const checkSupplierInvoice = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			"number?": "string",
			"total?": "number >= 0",
			"freight?": "number >= 0",
			"tax?": "number >= 0",
			"credits?": "number > 0",
			lines: invoiceLine.array().atLeastLength(1),
		}),
	)
	.handler(async ({ data: { credits, ...data } }) => {
		const db = getDb();
		const lines = linesOf(data.lines, credits);
		const [check, po] = await Promise.all([
			matchInvoice(db, { ...data, lines }),
			loadOrder(db, data.purchaseOrderId),
		]);
		const draft = draftMatchable(evidenceOf(lines, po.lines));
		const linesCents = draft.reduce(
			(n, l) => n + (l.kind === "credit" ? -l.amountCents : l.amountCents),
			0,
		);
		const freightCents = centsOf(data.freight ?? 0, "Freight");
		const taxCents = centsOf(data.tax ?? 0, "Tax");
		const billing = await billingOf(db, data.purchaseOrderId, {
			id: -1,
			totalCents:
				data.total === undefined
					? linesCents + freightCents + taxCents
					: centsOf(data.total, "Total"),
			activeSince: new Date(8.64e15),
			voided: false,
			itemization: { kind: "itemized", freightCents, taxCents, lines: draft },
		});
		return {
			...check,
			cumulative: { match: billing.draft, lines: billing.lines },
		};
	});

export type InvoiceCheck = Awaited<ReturnType<typeof checkSupplierInvoice>>;

export const recordSupplierInvoice = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			number: "string > 0",
			invoicedOn: "string",
			"dueOn?": "string | null",
			total: "number >= 0",
			"currency?": "'USD'",
			"freight?": "number >= 0",
			"tax?": "number >= 0",
			"credits?": "number > 0",
			"lines?": invoiceLine.array(),
		}),
	)
	.handler(async ({ data: { credits, lines, ...data } }) =>
		recordInvoice(
			getDb(),
			{
				...data,
				lines: lines || credits ? linesOf(lines ?? [], credits) : undefined,
			},
			requireActor(),
		),
	);

export const voidSupplierInvoice = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", "reason?": "string | null" }))
	.handler(async ({ data }) => voidInvoice(getDb(), data, requireActor()));

export const removeSupplierInvoice = voidSupplierInvoice;

export const restoreSupplierInvoice = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => restoreInvoice(getDb(), data, requireActor()));

// Saves the item numbers an invoice showed onto the PO's products, for its
// supplier. A product that already has a number keeps it.
export const saveSupplierSkus = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			items: type({ sku: "string > 0", supplierSku: "string > 0" })
				.array()
				.atLeastLength(1),
		}),
	)
	.handler(async ({ data }) => {
		const db = getDb();
		const po = await loadOrder(db, data.purchaseOrderId);
		const found = await db
			.select({ id: products.id, sku: products.sku })
			.from(products)
			.where(
				inArray(
					products.sku,
					data.items.map((i) => i.sku),
				),
			);
		const bySku = new Map(found.map((p) => [p.sku, p.id]));
		const entries = data.items.flatMap((i) => {
			const productId = bySku.get(i.sku);
			return productId === undefined ? [] : [{ productId, ...i }];
		});
		return fillSupplierSkus(db, {
			supplierId: po.supplier.id,
			entries,
			replace: false,
		});
	});
