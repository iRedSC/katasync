import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { eq, sql } from "drizzle-orm";
import { getDb } from "#/db/client";
import { purchaseOrderLines, purchaseOrders, suppliers } from "#/db/schema";
import { backOrderedUnits, receivedByLine } from "#/purchasing/load";
import {
	receive,
	receiveExtra,
	setBackOrdered,
	setReceivingNote,
	undoReceipt,
} from "#/purchasing/orders";
import { receiptDiscount } from "./discount-input";
import { id } from "./id-input";

// Notes a line for receiving; null takes the note off.
export const setLineReceivingNote = createServerFn({ method: "POST" })
	.validator(type({ lineId: "number.integer > 0", note: "string | null" }))
	.handler(async ({ data }) => setReceivingNote(getDb(), data));

// The supplier said what hasn't come of a line is back-ordered, or no longer.
export const setLineBackOrdered = createServerFn({ method: "POST" })
	.validator(type({ lineId: "number.integer > 0", backOrdered: "boolean" }))
	.handler(async ({ data }) => setBackOrdered(getDb(), data));

// `last`: nothing more of it is coming, so the line expects only what came.
export const receiveLine = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			"last?": "boolean",
			"discount?": receiptDiscount,
		}),
	)
	.handler(async ({ data }) => receive(getDb(), data));

// Something in the box that isn't on the PO: added and received at once.
export const receiveExtraLine = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			productId: "number.integer > 0",
			quantity: "number.integer > 0",
			"discount?": receiptDiscount,
		}),
	)
	.handler(async ({ data }) => receiveExtra(getDb(), data));

export const undoPurchaseReceipt = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => undoReceipt(getDb(), data.id));

// POs waiting on deliveries, for the receiving app.
export const listReceivable = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const received = receivedByLine(db);
		return db
			.select({
				id: purchaseOrders.id,
				supplierName: suppliers.name,
				expectedAt: purchaseOrders.expectedAt,
				lines: sql<number>`count(*)::int`,
				ordered: sql<number>`sum(${purchaseOrderLines.quantity} * ${purchaseOrderLines.packSize})::int`,
				received: sql<number>`coalesce(sum(least(coalesce(${received.units}, 0), ${purchaseOrderLines.quantity}) * ${purchaseOrderLines.packSize}), 0)::int`,
				backOrdered: backOrderedUnits(received),
			})
			.from(purchaseOrders)
			.innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
			.innerJoin(
				purchaseOrderLines,
				eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id),
			)
			.leftJoin(received, eq(received.lineId, purchaseOrderLines.id))
			.where(eq(purchaseOrders.status, "sent"))
			.groupBy(purchaseOrders.id, suppliers.id)
			.orderBy(purchaseOrders.expectedAt);
	},
);
