import type { Db } from "#/db/client";
import { reorderBreakdown } from "./breakdown";
import { MIN_AT_RISK } from "./suggested";

// Products losing profit if their reorder waits a week, the most first:
// what Home puts in front of whoever buys. Open POs that land in time
// already take a product off (see ./priority.ts).
export async function losingProfit(db: Db, now = new Date()) {
	const all = await reorderBreakdown(db, { now });
	return all
		.flatMap(({ line, why }) =>
			why.priority && why.priority.atRisk >= MIN_AT_RISK
				? [
						{
							sku: line.sku,
							name: line.name,
							variantName: line.variantName,
							imageUrl: line.imageUrl,
							priority: why.priority,
						},
					]
				: [],
		)
		.sort((a, b) => b.priority.atRisk - a.priority.atRisk);
}
