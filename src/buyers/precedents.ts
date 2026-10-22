import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_BASE_PROMPT } from "#/ai/agents";
import type { Db } from "#/db/client";
import { replyBasePrompt, replyPrecedents } from "#/db/schema";

// What staff decided to do in a kind of case, which the reply agent follows:
// "when a buyer says the box came empty", "then apologise and send another,
// no return needed". Server only.

export const precedentSchema = z.object({
	name: z.string().trim().min(1).max(60),
	when: z.string().trim().min(3).max(500),
	action: z.string().trim().min(3).max(2000),
});

export type Precedent = typeof replyPrecedents.$inferSelect;

export function listPrecedents(db: Db) {
	return db.select().from(replyPrecedents).orderBy(asc(replyPrecedents.id));
}

// Adds one, or with an id rewrites it.
export async function savePrecedent(
	db: Db,
	id: number | null,
	input: z.infer<typeof precedentSchema>,
	by: "staff" | "claude",
) {
	const p = precedentSchema.parse(input);
	const values = {
		name: p.name,
		when: p.when,
		action: p.action,
		by,
		updatedAt: new Date(),
	};
	const [row] =
		id === null
			? await db.insert(replyPrecedents).values(values).returning()
			: await db
					.update(replyPrecedents)
					.set(values)
					.where(eq(replyPrecedents.id, id))
					.returning();
	if (!row) throw new Error(`There's no precedent ${id}`);
	return row;
}

// Deletes one; what was deleted comes back, for undo.
export async function deletePrecedent(db: Db, id: number) {
	const [row] = await db
		.delete(replyPrecedents)
		.where(eq(replyPrecedents.id, id))
		.returning();
	if (!row) throw new Error(`There's no precedent ${id}`);
	return row;
}

// Puts a deleted one back, under its old id so drafts that followed it
// still point at it.
export async function restorePrecedent(db: Db, p: Precedent) {
	const [row] = await db
		.insert(replyPrecedents)
		.overridingSystemValue()
		.values(p)
		.onConflictDoNothing()
		.returning();
	return row ?? p;
}

// The reply agent's base prompt: staff's, or the default when they've
// written none.
export async function basePrompt(db: Db) {
	const [row] = await db.select().from(replyBasePrompt);
	return row
		? {
				prompt: row.prompt,
				by: row.by,
				updatedAt: row.updatedAt,
				isDefault: false,
			}
		: {
				prompt: DEFAULT_BASE_PROMPT,
				by: null,
				updatedAt: null,
				isDefault: true,
			};
}

export const basePromptSchema = z.string().trim().min(20).max(8000);

// Saves the base prompt; null puts the default back.
export async function setBasePrompt(
	db: Db,
	prompt: string | null,
	by: "staff" | "claude",
) {
	if (prompt === null) {
		await db.delete(replyBasePrompt);
		return basePrompt(db);
	}
	const values = {
		prompt: basePromptSchema.parse(prompt),
		by,
		updatedAt: new Date(),
	};
	await db
		.insert(replyBasePrompt)
		.values({ id: 1, ...values })
		.onConflictDoUpdate({ target: replyBasePrompt.id, set: values });
	return basePrompt(db);
}
