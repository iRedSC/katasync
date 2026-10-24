// What the AI read in a supplier's email and what it did because of it
// (src/purchasing/inbox/ai-filing.ts), kept on po_email_ai, and the flags it
// and Claude raise on POs (src/purchasing/flags.ts). Types only, so the
// schema and the browser can use them.

export type Carrier = "ups" | "usps" | "fedex";

// Something a PO should change to, for staff to apply or dismiss: a line's
// price per its unit, its quantity in that unit, the line back-ordered, or
// anything else in words.
export type FlagKind = "price" | "quantity" | "back_order" | "note";

export type FlagInput =
	| { kind: "price" | "quantity"; sku: string; value: number; note: string }
	| { kind: "back_order"; sku: string; note: string }
	| { kind: "note"; sku: string | null; note: string };

// What the email says: packages to follow, and what to flag.
export type Proposal = {
	tracking: { number: string; carrier?: Carrier }[];
	flags: FlagInput[];
};

// What filing it did: the packages followed, and what it couldn't do and why.
export type Applied = {
	tracking: string[];
	skipped: { what: string; why: string }[];
};
