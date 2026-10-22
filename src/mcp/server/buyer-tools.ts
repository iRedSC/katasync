import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { aiConfigured } from "#/ai/harness";
import { draftThread, setDraft } from "#/buyers/drafts";
import {
	basePromptSchema,
	deletePrecedent,
	precedentSchema,
	savePrecedent,
	setBasePrompt,
} from "#/buyers/precedents";
import type { Db } from "#/db/client";
import { json, WRITE } from "./tool-shapes";

// Buyer messages' suggested replies and the precedents behind them. Claude
// can write a suggestion and teach precedents; staff send replies in the
// app, so nothing here sends one.

export function registerBuyerWriteTools(server: McpServer, db: Db) {
	server.registerTool(
		"set_reply_draft",
		{
			description:
				"Writes the suggested reply on a buyer thread (buyer_threads.id), replacing what's there; staff see it on the Inbox's Buyers page as by Claude and send it with one click. reply is what the buyer gets, in their language (buyer_messages.language of their latest message); english is the same in English when their language isn't English. It stays until the buyer writes again, when the agent drafts anew. Sends nothing.",
			inputSchema: {
				thread_id: z.number().int().positive(),
				reply: z.string().trim().min(1).max(5000),
				english: z.string().trim().min(1).max(5000).optional(),
			},
			annotations: WRITE,
		},
		async ({ thread_id, reply, english }) =>
			json(
				await setDraft(
					db,
					thread_id,
					{ body: reply, english: english ?? null },
					"claude",
				),
			),
	);

	server.registerTool(
		"draft_reply",
		{
			description:
				"Has katasync's reply agent draft the suggested reply on a buyer thread again now, from the order, the conversation, and the precedents (reply_precedents), replacing the suggestion. Returns the draft. Use after saving a precedent to see it followed. Sends nothing.",
			inputSchema: { thread_id: z.number().int().positive() },
			annotations: WRITE,
		},
		async ({ thread_id }) => {
			if (!aiConfigured())
				return json({
					skipped:
						"katasync's reply agent isn't set up (AI_PROXY_URL, AI_PROXY_KEY). Write the suggestion with set_reply_draft instead",
				});
			const d = await draftThread(db, thread_id, { force: true });
			return json(d ?? { drafting: "Another run is drafting it now" });
		},
	);

	server.registerTool(
		"save_precedent",
		{
			description:
				'Adds a precedent the reply agent follows (reply_precedents), or with id rewrites one: when a buyer\'s case is like `when`, then do `then`. Give it a short name staff know it by ("Empty box"); write when as the case ("buyer says the box arrived empty"), then as what we do and say ("apologise, ship a replacement today, no return needed"). Staff see it on the Inbox\'s Precedents page as by Claude.',
			inputSchema: {
				id: z.number().int().positive().optional(),
				name: precedentSchema.shape.name,
				when: precedentSchema.shape.when,
				// biome-ignore lint/suspicious/noThenProperty: the precedent's own word
				then: precedentSchema.shape.action,
			},
			annotations: WRITE,
		},
		async ({ id, name, when, then }) =>
			json(
				await savePrecedent(
					db,
					id ?? null,
					{ name, when, action: then },
					"claude",
				),
			),
	);

	server.registerTool(
		"set_reply_base_prompt",
		{
			description:
				"Rewrites the reply agent's base prompt (reply_base_prompt; none means the default): who we are, the tone, the marketplace rules, how replies open and close. The precedents and the answer's shape are added after it by katasync, so don't restate them. With reset, puts the default back. Staff see it at the top of the Inbox's Precedents page.",
			inputSchema: {
				prompt: basePromptSchema.optional(),
				reset: z.boolean().optional(),
			},
			annotations: WRITE,
		},
		async ({ prompt, reset }) => {
			if (!reset && prompt === undefined)
				throw new Error("Give a prompt, or reset to put the default back");
			return json(
				await setBasePrompt(db, reset ? null : (prompt ?? null), "claude"),
			);
		},
	);

	server.registerTool(
		"delete_precedent",
		{
			description:
				"Deletes a precedent (reply_precedents.id). Returns what was deleted, so it can be saved again.",
			inputSchema: { id: z.number().int().positive() },
			annotations: { ...WRITE, destructiveHint: true },
		},
		async ({ id }) => json(await deletePrecedent(db, id)),
	);
}
