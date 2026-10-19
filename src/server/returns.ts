import { createServerFn } from "@tanstack/react-start";
import { getDb } from "#/db/client";
import { returnInsights } from "#/orders/return-rates";

// Returns › Insights: what comes back, how often, and why.
export const getReturnInsights = createServerFn({ method: "GET" }).handler(() =>
	returnInsights(getDb()),
);
