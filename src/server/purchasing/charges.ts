import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { addCharge, removeCharge } from "#/purchasing/orders/charges";
import { id } from "./id-input";

export const addPurchaseOrderCharge = createServerFn({ method: "POST" })
	.validator(
		type({
			purchaseOrderId: "number.integer > 0",
			kind: "'freight' | 'duty' | 'fee' | 'credit'",
			amount: "number > 0",
		}),
	)
	.handler(async ({ data }) => addCharge(getDb(), data));

// Returns what was removed, so addPurchaseOrderCharge can put it back.
export const removePurchaseOrderCharge = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeCharge(getDb(), data.id));
