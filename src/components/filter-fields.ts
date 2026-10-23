// The search box's filter types as words: a dropdown of them while nothing
// is typed, and typing one out turns into its sigil, so "tag " is "#" and
// "tag not " or "not tag " is "#!".

export type FieldEntry = {
	label: string;
	// What picking it puts in the box, e.g. "#".
	insert: string;
	// Words that become `insert` once a space follows them.
	words: readonly string[];
	// Whether "not" makes it an exclusion, by adding "!" after insert.
	negatable: boolean;
};

// Entries for what's typed so far: all of them for nothing, else those with
// a word starting with it. One letter is too common in plain searches.
export function matchFields(fields: readonly FieldEntry[], word: string) {
	if (word === "") return fields;
	if (word.length < 2) return [];
	const w = word.toLowerCase();
	return fields.filter((f) => f.words.some((x) => x.startsWith(w)));
}

// The box's text with a field word just finished by a space turned into its
// sigil, or null when the last word isn't one.
export function expandAlias(fields: readonly FieldEntry[], text: string) {
	const m = /(^|\s)(?:(not)\s+)?(\S+)\s$/i.exec(text);
	if (!m) return null;
	const [whole, lead, not, word] = m;
	const start = m.index + lead.length;
	const lower = word.toLowerCase();
	const named = fields.find((f) => f.words.includes(lower));
	if (named) {
		const negate = not !== undefined && named.negatable;
		// "not" that isn't negating anything stays a search word.
		const from = negate
			? start
			: start + whole.length - lead.length - word.length - 1;
		return text.slice(0, from) + named.insert + (negate ? "!" : "");
	}
	// "#not " after the sigil is already there.
	const sigil = fields.find(
		(f) => f.negatable && lower === `${f.insert}not`.toLowerCase(),
	);
	if (sigil) {
		const at = text.length - word.length - 1;
		return `${text.slice(0, at)}${sigil.insert}!`;
	}
	return null;
}
