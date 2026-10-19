// What's typed on the box step. Numbers are a size, locked in one side at a
// time (12L 9W 4H); a letter turns it into a search of box names.
export type BoxEntry =
	| { kind: "size"; sides: string[]; typing: string }
	| { kind: "name"; text: string };

export type SizeEntry = Extract<BoxEntry, { kind: "size" }>;

export const emptyEntry: BoxEntry = { kind: "size", sides: [], typing: "" };

export const SIDE_LETTERS = ["L", "W", "H"];

// The filter text for src/shipping/box-filter.ts.
export const entryQuery = (e: BoxEntry) =>
	e.kind === "name" ? e.text : [...e.sides, e.typing].filter(Boolean).join(" ");

// The size input's new value, typed or pasted. A space, x, or comma locks in
// the side before it; a letter makes it a name search, keeping what's typed.
export function typeSize(entry: SizeEntry, raw: string): BoxEntry {
	if (/[a-wyz]/i.test(raw))
		return {
			kind: "name",
			text: [...entry.sides, raw].filter(Boolean).join(" "),
		};
	const parts = raw.replace(/[^\d.\sx×,*]/gi, "").split(/[\sx×,*]+/i);
	const typing = parts.pop() ?? "";
	const locked = parts.filter((p) => Number(p) > 0);
	const sides = [...entry.sides, ...locked].slice(0, 3);
	// All three locked: there's nothing left to type.
	return { kind: "size", sides, typing: sides.length === 3 ? "" : typing };
}

// Backspace with nothing typed reopens the side before.
export function reopenSide(entry: BoxEntry): BoxEntry | null {
	if (entry.kind !== "size" || entry.typing !== "" || entry.sides.length === 0)
		return null;
	return {
		kind: "size",
		sides: entry.sides.slice(0, -1),
		typing: entry.sides[entry.sides.length - 1],
	};
}

// A name search typed away to nothing is ready for a size again.
export const typeName = (text: string): BoxEntry =>
	text === "" ? emptyEntry : { kind: "name", text };
