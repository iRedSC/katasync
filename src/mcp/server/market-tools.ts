import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import { marketAnalytics } from "#/markets/analytics";
import { MARKETS } from "#/markets/market";
import { attentionQueue } from "#/markets/queue";
import { checkable, checkStale, readStanding } from "#/markets/refresh";
import { RANGES, type RangeKey, resolveRange } from "#/orders/profit";
import {
	mailboxMessage,
	messageContent,
	searchMailbox,
} from "#/purchasing/inbox/graph";
import { describeFile, fileContent, liveFiles } from "./email-files";
import { json, READ } from "./tool-shapes";

// The Markets tab over MCP: each marketplace's standing, the queue of what
// they flagged, and what sells where, with the same numbers as the page;
// and the marketplaces mailbox, where their notices arrive, read live.

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

	server.registerTool(
		"search_marketplace_mail",
		{
			description:
				'Searches the marketplaces mailbox (MARKETPLACE_INBOX, e.g. marketplaces@) in Microsoft 365, live: the notices Amazon, eBay, TikTok Shop, and Shopify send about the account, listings, policy, and payments, in every folder and as far back as it goes. words uses Outlook search (sender, subject, body, attachment names), e.g. "policy violation", an ASIN or SKU, or "from:amazon.com"; without words, lists newest first. since/until (ISO dates) narrow by when it arrived. Each result has graph_id for read_marketplace_email. Reads only; nothing is kept or changed.',
			inputSchema: {
				words: z.string().min(1).optional(),
				since: z.string().optional().describe("ISO date or time"),
				until: z.string().optional().describe("ISO date or time"),
				limit: z.number().int().min(1).max(100).optional(),
			},
			annotations: { ...READ, openWorldHint: true },
		},
		async ({ words, since, until, limit }) => {
			const found = await searchMailbox({
				box: "marketplaces",
				words,
				since: date(since, "since"),
				until: date(until, "until"),
				limit: limit ?? 25,
			});
			return json(
				found.map((m) => ({
					graph_id: m.graphId,
					from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
					to: m.recipients,
					subject: m.subject,
					receivedAt: m.receivedAt,
				})),
			);
		},
	);

	server.registerTool(
		"read_marketplace_email",
		{
			description:
				"Reads one email in the marketplaces mailbox by its graph_id from search_marketplace_mail, live: body and each attachment's text. With attachment (its index in attachments, from 0), that file itself too. Reads only.",
			inputSchema: {
				graph_id: z.string().min(1),
				attachment: z.number().int().min(0).optional(),
			},
			annotations: { ...READ, openWorldHint: true },
		},
		async ({ graph_id, attachment }) => {
			const [m, content] = await Promise.all([
				mailboxMessage(graph_id, "marketplaces"),
				messageContent(graph_id, "marketplaces"),
			]);
			const files = await liveFiles(content.attachments);
			const summary = {
				graph_id: m.graphId,
				from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
				to: m.recipients,
				subject: m.subject,
				receivedAt: m.receivedAt,
				body: content.body,
				attachments: files.map((f, index) =>
					describeFile(f, { index, ...(f.text ? { text: f.text } : {}) }),
				),
			};
			if (attachment === undefined) return json(summary);
			const file = files[attachment];
			if (!file)
				throw new Error(
					`That email has ${files.length} attachments; there's no ${attachment}`,
				);
			return {
				content: [
					...json({ ...summary, attachments: undefined }).content,
					...fileContent(
						`katasync://marketplaces/${encodeURIComponent(graph_id)}/${attachment}`,
						file,
						file.text,
					),
				],
			};
		},
	);
}

// An ISO date or time from a tool's input.
function date(s: string | undefined, name: string) {
	if (!s) return undefined;
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) throw new Error(`${name} isn't a date: ${s}`);
	return d;
}
