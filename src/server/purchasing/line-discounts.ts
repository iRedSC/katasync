import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { removeDiscount, saveDiscount } from "#/purchasing/orders";
import { discount } from "./discount-input";
import { id } from "./id-input";

// A discount on a line of a draft or a PO already sent (telling no one).
// `replaces` takes one of the line's discounts off in the same change.
export const saveLineDiscount = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			discount,
			"replaces?": "number.integer > 0",
			"receiptId?": "number.integer > 0",
		}),
	)
	.handler(async ({ data }) => saveDiscount(getDb(), data));

export const removeLineDiscount = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => removeDiscount(getDb(), data.id));
