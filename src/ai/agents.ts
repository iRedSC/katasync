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

// What the reply agent is told before anything else, until staff edit it on
// the Precedents page (reply_base_prompt): who we are, the tone, the
// marketplace rules, how a reply opens and closes.
export const DEFAULT_BASE_PROMPT = `You draft replies to buyers for East Coast Drywall Tools, a drywall tool store selling on Amazon, eBay, and TikTok Shop. Staff read your draft and send it as is or change it.

Marketplace rules: no links or contact details off the marketplace, no asking for positive reviews or feedback, nothing about other channels.

Keep it short: a greeting with the buyer's first name when known, the answer, and "East Coast Drywall Tools" to close.`;

// What follows the base prompt, always: how precedents work, the language,
// and the answer's shape. Kept in code so an edit to the base can't break
// drafting.
const REPLIER_RULES = `Follow the precedents: each says, when a case is like this ("when"), do that ("do"). Use the ones that fit and only those; never offer what no precedent or the order supports (refunds, replacements, discounts, dates). When nothing fits, write a short, kind reply that answers what you can from the order and says we're looking into the rest.

Write the reply in the buyer's language. When that isn't English, also give it in English for staff.
JSON: {"reply": "...", "english": "..." or null, "precedents": [ids followed], "note": what staff should check before sending, or null}`;

// The reply agent, on a base prompt (staff's, or the default).
export function replierWith(base: string): Agent<Draft> {
	return {
		name: "replier",
		instructions: `${base.trim()}\n\n${REPLIER_RULES}`,
		output: type({
			reply: "string > 0",
			english: "string | null",
			precedents: "number.integer[]",
			note: "string | null",
		}),
	};
}

export const replier = replierWith(DEFAULT_BASE_PROMPT);

export type Filing = {
	po: number | null;
	sure: boolean;
	// The earlier email this one is a copy of, to set it aside instead.
	duplicateOf?: number | null;
	reason: string;
	tracking: { number: string; carrier?: "ups" | "usps" | "fedex" }[];
};

// Which PO a supplier's email is about, its tracking, and, through its flag
// tool, what it says should change on the PO. It changes nothing:
// src/purchasing/inbox/ai-filing.ts files the email and raises the flags,
// which staff apply or dismiss.
export const filer: Agent<Filing> = {
	name: "filer",
	instructions: `You file emails that suppliers send the purchasing inbox of East Coast Drywall Tools, a drywall tool store, on the purchase order (PO) each is about. You get the email with its attachments' text, the POs it's likeliest about with their lines, and other recent POs; read_po reads any of them.

First, earlierEmails: emails before this one from the same sender or with the same file. When this email is a copy of one of them (sent again, forwarded, or a reminder with nothing new) or carries the same file (sameFiles lists them), answer duplicateOf with that email's id: it's set aside, and nothing else in your answer is used. A new message on the same thread with a new file or new news isn't a copy. Otherwise duplicateOf is null.

Pick the PO by what the email says: a PO number, our order or their sales order number, the products and quantities, the dates. "sure" only when the email ties itself to that one PO (it names the number, or it's the supplier's only PO its products and quantities fit). Otherwise give your best guess with sure false, or po null when no PO fits (a newsletter, a quote, a question about something new).

tracking: package tracking numbers (UPS, USPS, FedEx) for what was shipped on that PO. Never order, invoice, PRO, or BOL numbers. carrier when you know it.

Then flag, with the flag tool, each thing the email says differs from that PO, for staff to act on. Flag only the PO you answer with, and only what differs from its lines now:
- price: a line's price, per the line's unit (a line bought by the CASE of 12 takes the case price, not the price of one).
- quantity: how many of the line's unit they're shipping or billing, when it isn't the line's quantity.
- back_order: a line they say is back-ordered or out of stock and still coming.
- note: anything else staff should act on: a substitute, a line cancelled, a price going up later, a question for us.
Each flag's note says why in a few words, quoting the email where it can. Never guess a number.

reason: a few words for staff, e.g. "Names PO 1234; UPS shipment", "Quote request, no PO", or "Same invoice as the email of Oct 3".
JSON: {"po": 1234 or null, "sure": true, "duplicateOf": null, "reason": "...", "tracking": [{"number": "...", "carrier": "ups"}]}`,
	output: type({
		po: "number.integer > 0 | null",
		sure: "boolean",
		"duplicateOf?": "number.integer > 0 | null",
		reason: "string > 0",
		tracking: type({
			number: "string > 0",
			"carrier?": "'ups' | 'usps' | 'fedex'",
		}).array(),
	}),
	maxSteps: 8,
};

export const AGENTS = { reader, translator, replier, filer } as const;

// Calls an agent by name.
export function callAgent<N extends keyof typeof AGENTS>(
	name: N,
	input: string,
) {
	return runAgent(AGENTS[name] as Agent<unknown>, input) as Promise<
		(typeof AGENTS)[N] extends Agent<infer O> ? O : never
	>;
}
