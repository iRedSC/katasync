import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { amendLine } from "#/purchasing/orders";

// Changes a sent PO's line without telling the supplier.
export const amendPurchaseLine = createServerFn({ method: "POST" })
	.validator(
		type({
			lineId: "number.integer > 0",
			"quantity?": "number.integer >= 0",
			"unitCost?": "number >= 0 | null",
		}),
	)
	.handler(async ({ data }) => amendLine(getDb(), data));
