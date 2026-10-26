import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { startShopifyThread } from "#/buyers/shopify-mail";
import { getDb } from "#/db/client";

// Email buyer on a Shopify order: its thread in the Buyers inbox, made the
// first time. Only server functions here, as in ./buyers.ts.
export const emailShopifyBuyer = createServerFn({ method: "POST" })
	.validator(type({ orderId: "number.integer > 0" }))
	.handler(async ({ data }) => startShopifyThread(getDb(), data.orderId));
