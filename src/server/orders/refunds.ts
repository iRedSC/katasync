import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	decideRefund,
	listRefundQueue,
	settleRefund,
	undoRefundDecision,
} from "#/orders/refund-queue";

// The Refunds view (src/orders/refund-queue.ts): what was checked in, and
// deciding what to do about each buyer's money.

export const getRefundQueue = createServerFn({ method: "GET" }).handler(() =>
	listRefundQueue(getDb()),
);

export type RefundQueueData = Awaited<ReturnType<typeof getRefundQueue>>;

export const decideOrderRefund = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			decision: "'full' | 'partial' | 'none' | 'other'",
			amount: "number > 0 | null",
			note: "string <= 1000 | null",
			after: "number.integer > 0 | null",
		}),
	)
	.handler(({ data }) => decideRefund(getDb(), data));

export const undoOrderRefund = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(({ data }) => undoRefundDecision(getDb(), data.id));

export const settleOrderRefund = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0", settled: "boolean" }))
	.handler(({ data }) => settleRefund(getDb(), data.id, data.settled));
