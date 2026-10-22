import { type } from "arktype";
import { type Agent, runAgent } from "./harness";

// The agents katasync calls, by name, each with the one job it does.

// What language a buyer wrote in, and their words in English.
export const reader: Agent<{ language: string; english: string | null }> = {
	name: "reader",
	instructions: `You read messages buyers send an online store. Say which language the message is in as its ISO 639-1 code (en, es, ...), and give the message in plain English when it isn't English (null when it is). Translate faithfully: keep order numbers, product names, and amounts as written; add nothing.
JSON: {"language": "es", "english": "..."}`,
	output: type({
		language: /^[a-z]{2}$/,
		english: "string | null",
	}),
};

// A reply staff wrote in English, put in the buyer's language.
export const translator: Agent<{ text: string }> = {
	name: "translator",
	instructions: `You translate a store's replies to its buyers. Translate the reply into the language given, as a native speaker writing to a customer would: polite, plain, the same meaning and nothing added. Keep order numbers, product names, and amounts as written.
JSON: {"text": "..."}`,
	output: type({ text: "string > 0" }),
};

export type Draft = {
	reply: string;
	english: string | null;
	precedents: number[];
	note: string | null;
};

// A suggested reply to a buyer, following what staff decided in cases like
// it.
export const replier: Agent<Draft> = {
	name: "replier",
	instructions: `You draft replies to buyers for East Coast Drywall Tools, a drywall tool store selling on Amazon, eBay, and TikTok Shop. Staff read your draft and send it as is or change it.

Follow the precedents: each says, when a case is like this ("when"), do that ("do"). Use the ones that fit and only those; never offer what no precedent or the order supports (refunds, replacements, discounts, dates). When nothing fits, write a short, kind reply that answers what you can from the order and says we're looking into the rest.

Marketplace rules: no links or contact details off the marketplace, no asking for positive reviews or feedback, nothing about other channels. Keep it short: a greeting with the buyer's first name when known, the answer, and "East Coast Drywall Tools" to close.

Write the reply in the buyer's language. When that isn't English, also give it in English for staff.
JSON: {"reply": "...", "english": "..." or null, "precedents": [ids followed], "note": what staff should check before sending, or null}`,
	output: type({
		reply: "string > 0",
		english: "string | null",
		precedents: "number.integer[]",
		note: "string | null",
	}),
};

export const AGENTS = { reader, translator, replier } as const;

// Calls an agent by name.
export function callAgent<N extends keyof typeof AGENTS>(
	name: N,
	input: string,
) {
	return runAgent(AGENTS[name] as Agent<unknown>, input) as Promise<
		(typeof AGENTS)[N] extends Agent<infer O> ? O : never
	>;
}
