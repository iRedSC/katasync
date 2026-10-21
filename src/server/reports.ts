import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { parsePeriod, salesReport } from "#/orders/sales-report";

// Sales and sales tax for one month, quarter or year ("2026-09", "2026-Q3",
// "2026"), for the accountant.
export const getSalesReport = createServerFn({ method: "GET" })
	.validator(type({ period: "string" }))
	.handler(async ({ data }) => {
		const period = parsePeriod(data.period);
		if (!period) throw new Error(`Not a period: ${data.period}`);
		return salesReport(getDb(), period);
	});
