import { type } from "arktype";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Agent, jsonIn, runAgent } from "./harness";

// The proxy, answering from a script of replies, keeping what it was sent.
function proxy(replies: unknown[]) {
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
		sent.push({ url, body: JSON.parse(String(init?.body)) });
		const next = replies.shift();
		if (!next) throw new Error("No more replies");
		return new Response(JSON.stringify({ choices: [{ message: next }] }));
	}) as unknown as typeof fetch;
	return { sent, fetchImpl };
}

const agent: Agent<{ answer: number }> = {
	name: "adder",
	instructions: "Add numbers.",
	output: type({ answer: "number" }),
	tools: [
		{
			name: "add",
			description: "Adds a and b",
			parameters: {
				type: "object",
				properties: { a: { type: "number" }, b: { type: "number" } },
			},
			run: async (i) => (i.a as number) + (i.b as number),
		},
	],
};

beforeEach(() => {
	vi.stubEnv("AI_PROXY_URL", "https://ai.example.com/");
	vi.stubEnv("AI_PROXY_KEY", "k");
	vi.stubEnv("AI_MODEL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("the harness", () => {
	test("runs the tools the model calls, then reads its answer", async () => {
		const { sent, fetchImpl } = proxy([
			{
				content: null,
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "add", arguments: '{"a":2,"b":3}' },
					},
				],
			},
			{ content: '```json\n{"answer": 5}\n```' },
		]);
		expect(await runAgent(agent, "2+3?", { fetchImpl })).toEqual({ answer: 5 });
		expect(sent[0]?.url).toBe("https://ai.example.com/v1/chat/completions");
		expect(sent[0]?.body.model).toBe("claude-sonnet-5-5");
		expect(sent[1]?.body.messages).toContainEqual({
			role: "tool",
			tool_call_id: "c1",
			content: "5",
		});
	});

	test("asks once more when the answer doesn't fit, then gives up", async () => {
		const ok = proxy([{ content: "five" }, { content: '{"answer": 5}' }]);
		expect(await runAgent(agent, "?", { fetchImpl: ok.fetchImpl })).toEqual({
			answer: 5,
		});
		const bad = proxy([{ content: '{"answer": "5"}' }, { content: "no" }]);
		await expect(
			runAgent(agent, "?", { fetchImpl: bad.fetchImpl }),
		).rejects.toThrow(/adder answered in the wrong shape/);
	});

	test("a tool that fails tells the model, which carries on", async () => {
		const { sent, fetchImpl } = proxy([
			{
				content: null,
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "nope", arguments: "{}" },
					},
				],
			},
			{ content: '{"answer": 0}' },
		]);
		await runAgent(agent, "?", { fetchImpl });
		expect(sent[1]?.body.messages).toContainEqual(
			expect.objectContaining({
				role: "tool",
				content: "There's no tool nope",
			}),
		);
	});

	test("without the proxy set, says so", async () => {
		vi.stubEnv("AI_PROXY_URL", "");
		await expect(runAgent(agent, "?")).rejects.toThrow(/AI_PROXY_URL/);
	});

	test("finds JSON with words around it", () => {
		expect(jsonIn('Here: {"a": 1}')).toEqual({ a: 1 });
	});

	test("doesn't start a request it can't finish by the deadline", async () => {
		const { sent, fetchImpl } = proxy([{ content: '{"answer": 1}' }]);
		await expect(
			runAgent(agent, "?", { fetchImpl, deadline: Date.now() + 5_000 }),
		).rejects.toThrow(/Out of time/);
		expect(sent).toEqual([]);
	});

	test("an address ending in /v1 works too", async () => {
		vi.stubEnv("AI_PROXY_URL", "https://ai.example.com/v1/");
		const { sent, fetchImpl } = proxy([{ content: '{"answer": 1}' }]);
		await runAgent(agent, "?", { fetchImpl });
		expect(sent[0]?.url).toBe("https://ai.example.com/v1/chat/completions");
	});

	test("past its steps, a tool the model calls anyway isn't run, and it stops", async () => {
		const run = vi.fn(async () => 1);
		const limited: Agent<{ answer: number }> = {
			...agent,
			maxSteps: 1,
			tools: (agent.tools ?? []).map((t) => ({ ...t, run })),
		};
		const call = (id: string) => ({
			content: null,
			tool_calls: [
				{
					id,
					type: "function",
					function: { name: "add", arguments: '{"a":1,"b":1}' },
				},
			],
		});
		// A model that never stops calling tools.
		const { sent, fetchImpl } = proxy(
			Array.from({ length: 50 }, (_, i) => call(`c${i}`)),
		);
		await expect(runAgent(limited, "?", { fetchImpl })).rejects.toThrow(
			/adder didn't answer within 3 requests/,
		);
		expect(run).toHaveBeenCalledTimes(1);
		expect(sent).toHaveLength(3);
		expect(sent.map((r) => "tools" in r.body)).toEqual([true, false, false]);
		expect(sent[2]?.body.messages).toContainEqual(
			expect.objectContaining({
				role: "tool",
				tool_call_id: "c1",
				content: expect.stringMatching(/^Not run/),
			}),
		);
	});

	test("an answer after its last step is still read", async () => {
		const { fetchImpl } = proxy([
			{
				content: null,
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "add", arguments: '{"a":2,"b":2}' },
					},
				],
			},
			{ content: '{"answer": 4}' },
		]);
		expect(
			await runAgent({ ...agent, maxSteps: 1 }, "?", { fetchImpl }),
		).toEqual({ answer: 4 });
	});
});
