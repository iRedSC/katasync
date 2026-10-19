import { createServerFn } from "@tanstack/react-start";
import { getDb } from "#/db/client";
import { recentReturns } from "#/orders/recent-returns";
import { returnInsights } from "#/orders/return-rates";

// Returns › Insights: what comes back, how often, and why.
export const getReturnInsights = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [insights, recent] = await Promise.all([
			returnInsights(db),
			recentReturns(db),
		]);
		return { ...insights, recent };
	},
);
