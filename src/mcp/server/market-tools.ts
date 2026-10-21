import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import { marketAnalytics } from "#/markets/analytics";
import { MARKETS } from "#/markets/market";
import { attentionQueue } from "#/markets/queue";
import { checkable, checkStale, readStanding } from "#/markets/refresh";
import { RANGES, type RangeKey, resolveRange } from "#/orders/profit";
import { json, READ } from "./tool-shapes";

// The Markets tab over MCP: each marketplace's standing, the queue of what
// they flagged, and what sells where, with the same numbers as the page.

const rangeKeys = Object.keys(RANGES) as [RangeKey, ...RangeKey[]];

export function registerMarketTools(server: McpServer, db: Db) {
	server.registerTool(
		"markets",
		{
			description:
				"Each marketplace's account standing (the marketplace's own verdict, its metrics against its limits, and when it was read) and the attention queue: every problem a marketplace flagged, worst first, in its own words, with the listings or orders it's about and our product for each. Also sales per market over the range: totals against the period before, share, return rate, and counts of listings to fix, products not listed there, and products losing money there. With market, that market's lists too: best sellers, listings to fix, sells elsewhere but not here, losing money here, selling less than before, returned more here. Standing is read every 6 hours; check reads it from the marketplaces now (takes up to a minute).",
			inputSchema: {
				market: z.enum(MARKETS).optional(),
				range: z
					.enum(rangeKeys)
					.optional()
					.describe("Sales range; default last_30_days"),
				check: z
					.boolean()
					.optional()
					.describe("Read standing from the marketplaces first"),
			},
			annotations: { ...READ, openWorldHint: true },
		},
		async ({ market, range = "last_30_days", check }) => {
			if (check) await checkStale(db, 0);
			const [rows, analytics] = await Promise.all([
				readStanding(db),
				resolveRange(db, range).then((r) => marketAnalytics(db, r)),
			]);
			const queue = await attentionQueue(db, rows);
			const only = <T extends { market: string }>(list: T[]) =>
				market ? list.filter((x) => x.market === market) : list;
			return json({
				range,
				connected: checkable,
				standing: only(rows).map((r) => ({
					market: r.market,
					level: r.standing?.level ?? null,
					verdict: r.standing?.verdict ?? null,
					metrics: r.standing?.metrics ?? [],
					checkedAt: r.checkedAt,
					lastCheckFailed: r.error,
				})),
				queue: only(queue),
				markets: only(analytics).map((m) =>
					market
						? m
						: {
								market: m.market,
								totals: m.totals,
								previous: m.previous,
								share: m.share,
								returns: m.returns,
								counts: m.counts,
							},
				),
			});
		},
	);
}
