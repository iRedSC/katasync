import type { Db } from "#/db/client";
import { mcpCalls } from "#/db/schema";
import { READ_TOOLS } from "./server";

// Keeps a record of every change made through /mcp, read from the JSON-RPC
// request and the response the server gave. Calls to tools that only read
// aren't kept.

const MAX_RESULT = 2000;

type Message = {
	id?: unknown;
	method?: string;
	params?: { name?: string; arguments?: unknown };
};
type Reply = {
	id?: unknown;
	result?: { isError?: boolean; content?: { text?: string }[] };
	error?: { message?: string };
};

const list = <T>(v: unknown): T[] =>
	Array.isArray(v) ? v : v && typeof v === "object" ? [v as T] : [];

export async function logCalls(
	db: Db,
	tokenName: string,
	request: unknown,
	response: unknown,
) {
	const replies = list<Reply>(response);
	const rows = list<Message>(request)
		.filter(
			(m) =>
				m.method === "tools/call" &&
				typeof m.params?.name === "string" &&
				!READ_TOOLS.has(m.params.name),
		)
		.map((m) => {
			const reply = replies.find((r) => r.id === m.id);
			const ok = Boolean(reply?.result && !reply.result.isError);
			const text =
				reply?.error?.message ??
				reply?.result?.content?.[0]?.text ??
				"(no answer)";
			return {
				tokenName,
				tool: m.params?.name ?? "",
				arguments: m.params?.arguments ?? {},
				ok,
				result:
					text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…` : text,
			};
		});
	if (rows.length > 0) await db.insert(mcpCalls).values(rows);
	return rows.length;
}
