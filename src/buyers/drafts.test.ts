import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_BASE_PROMPT } from "#/ai/agents";
import { type Agent, OutOfTimeError } from "#/ai/harness";
import type { Db } from "#/db/client";
import { buyerMessages, replyDrafts } from "#/db/schema";
import { createTestDb } from "#/test/db";
import {
	draftThread,
	draftWaiting,
	readNewMessages,
	setDraft,
	translateForBuyer,
} from "./drafts";
import { basePrompt, savePrecedent, setBasePrompt } from "./precedents";
import { runBuyerMessages } from "./run";
import { reply } from "./send";
import { ensureThread, recordFromBuyer, threadsPage } from "./threads";

// The agents, answered by the test: each by name.
type Answers = Record<string, (input: string) => unknown>;
const fake =
	(answers: Answers) =>
	async <O>(agent: Agent<O>, input: string): Promise<O> => {
		const answer = answers[agent.name];
		if (!answer) throw new Error(`No answer for ${agent.name}`);
		return (await answer(input)) as O;
	};

let db: Db;
let threadId: number;
let n = 0;
beforeEach(async () => {
	db = await createTestDb();
	const t = await ensureThread(db, {
		market: "ebay",
		externalId: "c1",
		subject: "About your scraper",
		buyerName: "Ana",
	});
	threadId = t.id;
	await buyerSays("¿Llega antes del viernes?");
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function buyerSays(body: string) {
	n++;
	await recordFromBuyer(db, threadId, {
		externalId: `b${n}`,
		body,
		at: new Date(Date.now() - 60_000 + n),
	});
}

const spanish = {
	reader: () => ({ language: "es", english: "Will it arrive before Friday?" }),
	replier: (input: string) => ({
		reply: "Hola Ana, sí.",
		english: "Hi Ana, yes.",
		precedents: [JSON.parse(input).precedents[0]?.id ?? 0, 999],
		note: null,
	}),
};

describe("suggested replies", () => {
	test("reads the buyer's language, then drafts in it, following precedents", async () => {
		const p = await savePrecedent(
			db,
			null,
			{
				name: "Arrival",
				when: "Buyer asks when it arrives",
				action: "Give the ship date",
			},
			"staff",
		);
		const run = fake(spanish);
		expect(await readNewMessages(db, 20, run)).toEqual({
			read: 1,
			problems: [],
		});
		expect(await draftWaiting(db, 4, run)).toBe(1);
		// Current: not drafted again.
		expect(await draftWaiting(db, 4, run)).toBe(0);
		const [t] = await threadsPage(db, "open", null);
		expect(t?.language).toBe("es");
		expect(t?.messages[0]?.english).toBe("Will it arrive before Friday?");
		expect(t?.draft).toMatchObject({
			state: "ready",
			body: "Hola Ana, sí.",
			english: "Hi Ana, yes.",
			by: "ai",
			stale: false,
			// The made-up 999 is dropped.
			precedents: [{ id: p.id, name: "Arrival" }],
		});
	});

	test("a new buyer message drafts it again, even over an edit", async () => {
		const run = fake(spanish);
		await draftThread(db, threadId, { run });
		await setDraft(db, threadId, { body: "Mine" }, "claude");
		expect(await draftWaiting(db, 4, run)).toBe(0);
		await buyerSays("¿Hola?");
		expect((await threadsPage(db, "open", null))[0]?.draft?.stale).toBe(true);
		expect(await draftWaiting(db, 4, run)).toBe(1);
		expect((await threadsPage(db, "open", null))[0]?.draft?.body).toBe(
			"Hola Ana, sí.",
		);
	});

	test("an edit saved while the agent writes is kept", async () => {
		let release = () => {};
		const slow = fake({
			replier: () =>
				new Promise((resolve) => {
					release = () =>
						resolve({ reply: "AI", english: null, precedents: [], note: null });
				}),
		});
		const drafting = draftThread(db, threadId, { run: slow });
		await vi.waitFor(async () => {
			const [d] = await db.select().from(replyDrafts);
			expect(d?.state).toBe("drafting");
		});
		// A second run doesn't draft it too.
		expect(await draftThread(db, threadId, { run: slow })).toBeNull();
		await setDraft(db, threadId, { body: "From Claude" }, "claude");
		release();
		expect(await drafting).toBeNull();
		const [t] = await threadsPage(db, "open", null);
		expect(t?.draft).toMatchObject({ body: "From Claude", by: "claude" });
	});

	test("a failure says why, and isn't retried at once", async () => {
		const run = fake({
			replier: () => {
				throw new Error("The AI proxy answered 502: down");
			},
		});
		expect(await draftThread(db, threadId, { run })).toBeNull();
		expect((await threadsPage(db, "open", null))[0]?.draft).toMatchObject({
			state: "failed",
			error: "The AI proxy answered 502: down",
		});
		expect(await draftWaiting(db, 4, run)).toBe(0);
	});

	test("a failure after a new message waits too, until the buyer writes again", async () => {
		await draftThread(db, threadId, { run: fake(spanish) });
		await buyerSays("¿Hola?");
		let tries = 0;
		const down = fake({
			replier: () => {
				tries++;
				throw new Error("The AI proxy answered 502: down");
			},
		});
		expect(await draftWaiting(db, 4, down)).toBe(0);
		expect(tries).toBe(1);
		// The next run leaves it for the retry delay.
		expect(await draftWaiting(db, 4, down)).toBe(0);
		expect(await draftThread(db, threadId, { run: down })).toBeNull();
		expect(tries).toBe(1);
		await buyerSays("¿Alguien?");
		expect(await draftWaiting(db, 4, fake(spanish))).toBe(1);
	});

	test("sending a reply uses the suggestion up", async () => {
		await setDraft(db, threadId, { body: "Sí" }, "staff");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		await reply(db, threadId, "Sí", crypto.randomUUID());
		expect(await db.select().from(replyDrafts)).toEqual([]);
	});

	test("staff's English goes into the buyer's language", async () => {
		await db
			.update(buyerMessages)
			.set({ language: "es", english: "Will it arrive?" });
		const run = fake({
			translator: (input: string) => {
				expect(JSON.parse(input)).toEqual({ to: "es", reply: "Yes, Friday." });
				return { text: "Sí, el viernes." };
			},
		});
		expect(await translateForBuyer(db, threadId, "Yes, Friday.", run)).toEqual({
			language: "es",
			text: "Sí, el viernes.",
		});
	});

	test("without the AI set up, a run drafts nothing and nothing fails", async () => {
		vi.stubEnv("AI_PROXY_URL", "");
		vi.stubEnv("AI_PROXY_KEY", "");
		vi.stubEnv("EBAY_REFRESH_TOKEN", "");
		const r = await runBuyerMessages(db);
		expect(r.ai).toEqual({ skipped: "set AI_PROXY_URL and AI_PROXY_KEY" });
		expect(r.amazon.problems).toEqual([]);
		expect(await db.select().from(replyDrafts)).toEqual([]);
		const [t] = await threadsPage(db, "open", null);
		expect(t?.draft).toBeNull();
		expect(t?.messages[0]?.english).toBeNull();
	});

	test("a claim left by a run that died is taken over by the next", async () => {
		const run = fake(spanish);
		await db.insert(replyDrafts).values({
			threadId,
			state: "drafting",
			by: "ai",
			forMessageId: (await db.select().from(buyerMessages))[0]?.id,
			updatedAt: new Date(Date.now() - 10 * 60_000),
		});
		expect(await draftWaiting(db, 4, run)).toBe(1);
		expect((await threadsPage(db, "open", null))[0]?.draft?.state).toBe(
			"ready",
		);
	});

	test("out of time leaves it for the next run, not failed", async () => {
		const late = fake({
			replier: () => {
				throw new OutOfTimeError("Out of time for the AI");
			},
		});
		expect(await draftWaiting(db, 4, late)).toBe(0);
		const [d] = await db.select().from(replyDrafts);
		expect(d?.state).toBe("drafting");
		expect(await draftWaiting(db, 4, fake(spanish))).toBe(1);
	});

	test("drafts start from staff's base prompt, or the default", async () => {
		const seen: string[] = [];
		const run = async <O>(agent: Agent<O>): Promise<O> => {
			seen.push(agent.instructions);
			return {
				reply: "Hola",
				english: "Hi",
				precedents: [],
				note: null,
			} as O;
		};
		await draftThread(db, threadId, { force: true, run });
		expect(seen[0]).toContain(DEFAULT_BASE_PROMPT);
		await setBasePrompt(
			db,
			"We are a friendly drywall tool shop. Sign off as Sam.",
			"staff",
		);
		await draftThread(db, threadId, { force: true, run });
		expect(seen[1]).toMatch(
			/^We are a friendly drywall tool shop\. Sign off as Sam\./,
		);
		// What follows the base is fixed: precedents and the answer's shape.
		expect(seen[1]).toContain("Follow the precedents");
		expect((await setBasePrompt(db, null, "staff")).isDefault).toBe(true);
		expect((await basePrompt(db)).prompt).toBe(DEFAULT_BASE_PROMPT);
	});
});
