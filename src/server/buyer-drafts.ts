import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { z } from "zod";
import { aiConfigured } from "#/ai/harness";
import { draftThread, setDraft, translateForBuyer } from "#/buyers/drafts";
import {
	basePrompt,
	basePromptSchema,
	deletePrecedent,
	listPrecedents,
	precedentSchema,
	restorePrecedent,
	savePrecedent,
	setBasePrompt,
} from "#/buyers/precedents";
import { getDb } from "#/db/client";

// Suggested replies, translation, and the precedents the agent follows.
// Only server functions here: a plain export would keep these imports in
// the browser bundle.

const thread = "number.integer > 0";

// Drafts the thread's reply again now, whatever there is.
export const draftReplyNow = createServerFn({ method: "POST" })
	.validator(type({ threadId: thread }))
	.handler(async ({ data }) => {
		if (!aiConfigured()) return null;
		return draftThread(getDb(), data.threadId, { force: true });
	});

// Staff's own version of the suggestion.
export const saveReplyDraft = createServerFn({ method: "POST" })
	.validator(
		type({ threadId: thread, body: "string > 0", "english?": "string | null" }),
	)
	.handler(async ({ data }) => setDraft(getDb(), data.threadId, data, "staff"));

// Staff's English, in the buyer's language.
export const translateReply = createServerFn({ method: "POST" })
	.validator(type({ threadId: thread, text: "string > 0" }))
	.handler(async ({ data }) =>
		// Without the AI, the words go as written.
		aiConfigured()
			? translateForBuyer(getDb(), data.threadId, data.text)
			: { language: null, text: data.text },
	);

// The precedents and the base prompt they follow on.
export const getPrecedents = createServerFn({ method: "GET" }).handler(
	async () => {
		const db = getDb();
		const [precedents, base] = await Promise.all([
			listPrecedents(db),
			basePrompt(db),
		]);
		return { precedents, base };
	},
);

export type PrecedentsPage = Awaited<ReturnType<typeof getPrecedents>>;

// Staff's base prompt; null puts the default back.
export const saveBasePrompt = createServerFn({ method: "POST" })
	.validator(z.object({ prompt: basePromptSchema.nullable() }))
	.handler(async ({ data }) => setBasePrompt(getDb(), data.prompt, "staff"));

export const savePrecedentFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.number().int().positive().nullable(),
			precedent: precedentSchema,
		}),
	)
	.handler(async ({ data }) =>
		savePrecedent(getDb(), data.id, data.precedent, "staff"),
	);

export const deletePrecedentFn = createServerFn({ method: "POST" })
	.validator(type({ id: "number.integer > 0" }))
	.handler(async ({ data }) => deletePrecedent(getDb(), data.id));

export const restorePrecedentFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.number().int().positive(),
			name: z.string(),
			when: z.string(),
			action: z.string(),
			by: z.enum(["staff", "claude"]),
			updatedAt: z.coerce.date(),
		}),
	)
	.handler(async ({ data }) => restorePrecedent(getDb(), data));
