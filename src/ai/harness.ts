import { type Type, type } from "arktype";

// A small agent harness over the CLI proxy (CLIProxyAPI): its
// OpenAI-compatible chat completions, so any model the proxy routes works.
// An agent is instructions, the tools it may call, and the shape of its
// answer; runAgent loops while the model calls tools, then reads and checks
// the answer, asking once more when it doesn't fit.
//
//   AI_PROXY_URL  the proxy's address, e.g. https://ai.example.com
//   AI_PROXY_KEY  one of its api-keys
//   AI_MODEL      the model to ask, as the proxy names it (default below)
//
// Server only.

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export function aiConfigured() {
	return Boolean(process.env.AI_PROXY_URL && process.env.AI_PROXY_KEY);
}

export class AiNotConfiguredError extends Error {
	name = "AiNotConfiguredError";
}

export class OutOfTimeError extends Error {
	name = "OutOfTimeError";
}

// One request's longest wait, and the least worth starting.
const REQUEST_MS = 120_000;
const MIN_REQUEST_MS = 20_000;

export type Tool = {
	name: string;
	description: string;
	// JSON Schema of its input.
	parameters: Record<string, unknown>;
	run: (input: Record<string, unknown>) => Promise<unknown>;
};

export type Agent<Out> = {
	name: string;
	instructions: string;
	tools?: Tool[];
	// What its answer must be: JSON this type accepts.
	output: Type<Out>;
	// How many rounds of tool calls before it must answer.
	maxSteps?: number;
};

type Message =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

type Choice = { message: { content: string | null; tool_calls?: ToolCall[] } };

// One request to the proxy.
async function complete(
	messages: Message[],
	tools: Tool[],
	fetchImpl: typeof fetch,
	deadline: number,
): Promise<Choice["message"]> {
	// Each request ends by the deadline, or doesn't start too close to it.
	const left = Math.min(REQUEST_MS, deadline - Date.now());
	if (left < MIN_REQUEST_MS) throw new OutOfTimeError("Out of time for the AI");
	const { AI_PROXY_URL, AI_PROXY_KEY, AI_MODEL } = process.env;
	if (!AI_PROXY_URL || !AI_PROXY_KEY)
		throw new AiNotConfiguredError("Set AI_PROXY_URL and AI_PROXY_KEY");
	const res = await fetchImpl(
		// The address with or without /v1 at its end.
		`${AI_PROXY_URL.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_PROXY_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: AI_MODEL?.trim() || DEFAULT_MODEL,
				messages,
				...(tools.length > 0
					? {
							tools: tools.map((t) => ({
								type: "function",
								function: {
									name: t.name,
									description: t.description,
									parameters: t.parameters,
								},
							})),
						}
					: {}),
			}),
			signal: AbortSignal.timeout(left),
		},
	);
	const text = await res.text();
	if (res.status === 404)
		// No such page: the address is wrong, not the request.
		throw new Error(
			`Nothing at ${new URL(res.url || AI_PROXY_URL).pathname} on the AI proxy. Check AI_PROXY_URL is the proxy's base address`,
		);
	if (!res.ok)
		throw new Error(
			`The AI proxy answered ${res.status}: ${text.slice(0, 500)}`,
		);
	const body = JSON.parse(text) as { choices?: Choice[] };
	const message = body.choices?.[0]?.message;
	if (!message)
		throw new Error(`The AI proxy sent no answer: ${text.slice(0, 500)}`);
	return message;
}

// The JSON in an answer: bare, or in a ``` block.
export function jsonIn(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
	const raw = (fenced ?? text).trim();
	const start = raw.search(/[{[]/);
	return JSON.parse(start > 0 ? raw.slice(start) : raw);
}

export async function runAgent<Out>(
	agent: Agent<Out>,
	input: string,
	{
		fetchImpl = fetch,
		deadline = Number.POSITIVE_INFINITY,
	}: {
		fetchImpl?: typeof fetch;
		// When it must be done by (ms since 1970), so a run with a time limit
		// stops asking rather than being cut off mid-write.
		deadline?: number;
	} = {},
): Promise<Out> {
	const tools = agent.tools ?? [];
	const messages: Message[] = [
		{
			role: "system",
			content: `${agent.instructions}\n\nAnswer with JSON only, no other words.`,
		},
		{ role: "user", content: input },
	];
	const maxSteps = agent.maxSteps ?? 4;
	// Every request a run may make: a round of tools per step, then its
	// answer, and once more when that doesn't fit. Past maxSteps no tool is
	// offered, and one the model calls anyway isn't run.
	const maxRequests = maxSteps + 2;
	let steps = 0;
	let retried = false;
	for (let request = 0; request < maxRequests; request++) {
		const offered = steps < maxSteps ? tools : [];
		const reply = await complete(messages, offered, fetchImpl, deadline);
		const calls = reply.tool_calls ?? [];
		messages.push({
			role: "assistant",
			content: reply.content,
			...(calls.length > 0 ? { tool_calls: calls } : {}),
		});
		if (calls.length > 0) {
			if (offered.length > 0) steps++;
			for (const call of calls)
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content:
						offered.length > 0
							? await callTool(tools, call)
							: "Not run: there are no more tool calls. Answer now with the JSON only.",
				});
			continue;
		}
		let problem: string;
		try {
			const out = agent.output(jsonIn(reply.content ?? ""));
			if (!(out instanceof type.errors)) return out as Out;
			problem = out.summary;
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
		if (retried)
			throw new Error(`${agent.name} answered in the wrong shape: ${problem}`);
		retried = true;
		messages.push({
			role: "user",
			content: `That answer didn't fit: ${problem}. Answer again with the JSON only.`,
		});
	}
	throw new Error(
		`${agent.name} didn't answer within ${maxRequests} requests to the AI`,
	);
}

// A tool's result for the model; its failure too, so the model can go on.
async function callTool(tools: Tool[], call: ToolCall) {
	const tool = tools.find((t) => t.name === call.function.name);
	if (!tool) return `There's no tool ${call.function.name}`;
	try {
		const input = JSON.parse(call.function.arguments || "{}");
		return JSON.stringify(await tool.run(input));
	} catch (error) {
		return `Failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}
