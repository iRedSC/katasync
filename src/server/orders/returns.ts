import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { refurbishOptions, refurbishReturn } from "#/orders/refurbish";
import { receiveReturn, undoReturns } from "#/orders/returns";
import {
	findReturnable,
	listReturns,
	markNoReturn,
	restoreNoReturn,
} from "#/orders/returns-due";

// Returns from the order page and the Returns tab: receiving them, refurbs,
// and nothing coming back.

export const receiveOrderReturn = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			lines: type({
				lineId: "number.integer > 0",
				quantity: "number.integer >= 0",
			}).array(),
			outcome: type("'restock' | 'write_off'").or({
				refurbishInto: "number.integer > 0",
			}),
		}),
	)
	.handler(({ data }) => receiveReturn(getDb(), data));

export const undoOrderReturn = createServerFn({ method: "POST" })
	.validator(type({ ids: "(number.integer > 0)[]" }))
	.handler(({ data }) => undoReturns(getDb(), data.ids));

// The refurb dialog: what a returned line's refurb starts as.
export const getRefurbishOptions = createServerFn({ method: "POST" })
	.validator(
		type({ orderId: "number.integer > 0", lineId: "number.integer > 0" }),
	)
	.handler(({ data }) => refurbishOptions(getDb(), data));

export const refurbishOrderReturn = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			lineId: "number.integer > 0",
			quantity: "number.integer > 0",
			condition: "string > 0",
			title: "string > 0",
			price: "number > 0",
			compareAtPrice: "number > 0 | null",
			weightGrams: "number.integer > 0 | null",
			vendor: "string",
			productType: "string",
			tags: "string[]",
			notes: "string",
		}),
	)
	.handler(({ data }) => refurbishReturn(getDb(), data));

// The Returns tab: what's due back, and what came back lately.
export const getReturns = createServerFn({ method: "GET" }).handler(() =>
	listReturns(getDb()),
);

export const searchReturnable = createServerFn({ method: "GET" })
	.validator(type({ q: "string <= 200" }))
	.handler(({ data }) => findReturnable(getDb(), data.q));

export const markOrderNoReturn = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0" }))
	.handler(({ data }) => markNoReturn(getDb(), data.orderId));

export const undoOrderNoReturn = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0", previous: "Date | null" }))
	.handler(({ data }) => restoreNoReturn(getDb(), data.orderId, data.previous));

export type ReturnsData = Awaited<ReturnType<typeof getReturns>>;
