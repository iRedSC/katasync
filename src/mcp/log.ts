import type { Db } from "#/db/client";
import { mcpCalls } from "#/db/schema";
import { READ_TOOLS } from "./server";

// Keeps a record of every change made through /mcp, read from the JSON-RPC
// request and the response the server gave. Calls to tools that only read
// aren't kept.

const MAX_RESULT = 2000;
const MAX_ARGUMENTS = 4000;
const MAX_TOOL_NAME = 100;
const MAX_DEPTH = 8;

// Names whose values are credentials; a client may pass one by mistake, and
// any app approved read only can read this log back.
const SECRET_KEY =
	/api.?key|authori[sz]ation|token|passw|secret|credential|cookie|bearer/i;
// Looks like one of our own tokens (see PREFIX in src/auth/oauth.ts).
const API_TOKEN = /ks_[A-Za-z0-9_-]{16,}/g;
const REDACTED = "[redacted]";

function redact(value: unknown, depth = 0): unknown {
	// jsonb can't hold a NUL, which would lose the whole log entry.
	if (typeof value === "string")
		return value.replace(API_TOKEN, REDACTED).replaceAll("\u0000", "");
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return "[too deep]";
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([k, v]) => [
			k.replaceAll("\u0000", ""),
			SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1),
		]),
	);
}

// What is kept of a call's arguments, for any tool (including ones that
// don't exist or that the app isn't allowed): credentials removed, and cut
// short with a marker if it's still big.
function loggedArguments(args: unknown) {
	const clean = redact(args ?? {});
	const text = JSON.stringify(clean);
	return text.length > MAX_ARGUMENTS
		? { truncated: `${text.slice(0, MAX_ARGUMENTS)}…`, length: text.length }
		: clean;
}

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
			const text = String(
				redact(
					reply?.error?.message ??
						reply?.result?.content?.[0]?.text ??
						"(no answer)",
				),
			);
			return {
				tokenName,
				tool: String(redact(m.params?.name ?? "")).slice(0, MAX_TOOL_NAME),
				arguments: loggedArguments(m.params?.arguments),
				ok,
				result:
					text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…` : text,
			};
		});
	if (rows.length > 0) await db.insert(mcpCalls).values(rows);
	return rows.length;
}
