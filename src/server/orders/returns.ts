import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { feedOnChannels } from "#/diagnostics/feed-record";
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

// The Returns tab: what's due back, what came back lately, and when each
// marketplace's returns were last read.
export const getReturns = createServerFn({ method: "GET" }).handler(
	async () => {
		const [list, returnsChecked, casesChecked, disputesChecked] =
			await Promise.all([
				listReturns(getDb()),
				feedOnChannels(getDb(), "returns"),
				feedOnChannels(getDb(), "cases"),
				feedOnChannels(getDb(), "disputes"),
			]);
		const checked = [
			...returnsChecked,
			...casesChecked,
			...disputesChecked,
		].filter((check) => check.state !== "unsupported");
		return { ...list, checked };
	},
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
