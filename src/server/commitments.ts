import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { readQuantityMode } from "#/inventory/commitments";
import { stockPositions } from "#/inventory/stock-position";

export const getQuantityMode = createServerFn({ method: "GET" }).handler(
	async () => ({ mode: await readQuantityMode(getDb(), "none") }),
);

export const getStockPositions = createServerFn({ method: "GET" })
	.validator(type({ productIds: type("number.integer > 0").array() }))
	.handler(async ({ data }) => [
		...(await stockPositions(getDb(), data.productIds)).values(),
	]);
