import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setThreadDone } from "#/buyers/threads";
import type { Db } from "#/db/client";
import { json, WRITE } from "./tool-shapes";

// Buyer threads are read in only to count those waiting on a reply; they're
// answered on the marketplaces. Claude can take one out of the count once
// nothing more is owed (a buyer's "thanks").

export function registerBuyerWriteTools(server: McpServer, db: Db) {
	server.registerTool(
		"set_buyer_thread_done",
		{
			description:
				"Takes a buyer thread (buyer_threads.id) out of the Inbox's Buyers count of unanswered messages, e.g. once nothing more is owed, or puts it back with done false. A new message from the buyer puts it back on its own. Sends nothing.",
			inputSchema: {
				thread_id: z.number().int().positive(),
				done: z.boolean(),
			},
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ thread_id, done }) => {
			await setThreadDone(db, thread_id, done);
			return json({ thread_id, done });
		},
	);
}
