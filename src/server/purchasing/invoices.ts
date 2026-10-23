import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { inArray } from "drizzle-orm";
import { getDb } from "#/db/client";
import { products } from "#/db/schema";
import {
	matchInvoice,
	recordInvoice,
	removeInvoice,
} from "#/purchasing/invoices";
import { loadOrder } from "#/purchasing/load";
import { fillSupplierSkus } from "#/purchasing/suppliers";
import { id } from "./id-input";

// Checks a supplier invoice against its PO, changing nothing. A POST only
// because the lines don't fit in a URL.
export const checkSupplierInvoice = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			"number?": "string",
			"total?": "number >= 0",
			"freight?": "number >= 0",
			"tax?": "number >= 0",
			// Discounts and other money the invoice takes off, together.
			"credits?": "number > 0",
			lines: type({
				line: "number.integer > 0",
				"sku?": "string",
				"supplierSku?": "string",
				quantity: "number.integer >= 0",
				unitCost: "number >= 0",
			})
				.array()
				.atLeastLength(1),
		}),
	)
	.handler(async ({ data: { credits, ...data } }) =>
		matchInvoice(getDb(), {
			...data,
			lines: [
				...data.lines.map((l) => ({ kind: "merchandise" as const, ...l })),
				...(credits ? [{ kind: "credit" as const, amount: credits }] : []),
			],
		}),
	);

export type InvoiceCheck = Awaited<ReturnType<typeof checkSupplierInvoice>>;

export const recordSupplierInvoice = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			number: "string > 0",
			// YYYY-MM-DD, which recordInvoice checks.
			invoicedOn: "string",
			"dueOn?": "string | null",
			total: "number >= 0",
		}),
	)
	.handler(async ({ data }) => recordInvoice(getDb(), data));

// Returns what was removed, so recordSupplierInvoice can put it back.
export const removeSupplierInvoice = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeInvoice(getDb(), data.id));

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
