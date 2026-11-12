import { type } from "arktype";
import { type Agent, runAgent } from "./harness";

// The agents katasync calls, by name, each with the one job it does.

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

export const AGENTS = { filer } as const;

// Calls an agent by name.
export function callAgent<N extends keyof typeof AGENTS>(
	name: N,
	input: string,
) {
	return runAgent(AGENTS[name] as Agent<unknown>, input) as Promise<
		(typeof AGENTS)[N] extends Agent<infer O> ? O : never
	>;
}
