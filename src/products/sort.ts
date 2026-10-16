// Sorting a list by any of its columns. Typed in the search box as a chip:
//
//   ^cost    lowest first (A to Z, oldest first)
//   ^!cost   highest first (Z to A, newest first)
//
// Several sort chips break ties in order: ^class ^!velocity sorts by class,
// then fastest sellers first within each class. Rows without a value (no
// cost, never sold) go last either way, so a descending sort never leads
// with blanks. Rows that tie on every key keep the order they came in.

export type SortValue = string | number | null;

// How a column reads in the sort menu and on its chip.
export type SortColumn = {
	label: string;
	// "lowest first" and "highest first", or words that fit the column better.
	asc: string;
	desc: string;
};

export type SortColumns<K extends string> = Readonly<Record<K, SortColumn>>;

export type SortTerm<K extends string> = { key: K; desc: boolean };
export type Sort<K extends string> = readonly SortTerm<K>[];

// Words that fit each kind of column, so every table says them the same way.
export const TEXT = { asc: "A to Z", desc: "Z to A" };
export const NUMBER = { asc: "lowest first", desc: "highest first" };
export const DATE = { asc: "oldest first", desc: "newest first" };

// "cost,-name": how a sort travels through the URL and the database.
export function spellSort<K extends string>(sort: Sort<K>) {
	return sort.map((t) => (t.desc ? `-${t.key}` : t.key)).join(",");
}

// The other way. Unknown columns and repeats are dropped rather than failing,
// so an old link or saved view still opens.
export function parseSort<K extends string>(
	text: string,
	columns: SortColumns<K>,
): Sort<K> {
	const terms: SortTerm<K>[] = [];
	for (const part of text.split(",")) {
		const desc = part.startsWith("-");
		const key = desc ? part.slice(1) : part;
		if (!isColumn(key, columns)) continue;
		if (terms.some((t) => t.key === key)) continue;
		terms.push({ key, desc });
	}
	return terms;
}

export function isColumn<K extends string>(
	key: string,
	columns: SortColumns<K>,
): key is K {
	return Object.hasOwn(columns, key);
}

// Adds a term at the end, or changes its direction where it already is: one
// column twice can't order anything.
export function withTerm<K extends string>(sort: Sort<K>, term: SortTerm<K>) {
	return sort.some((t) => t.key === term.key)
		? sort.map((t) => (t.key === term.key ? term : t))
		: [...sort, term];
}

// "Cost, lowest first": what a term does, in words.
export function describeTerm<K extends string>(
	term: SortTerm<K>,
	columns: SortColumns<K>,
) {
	const c = columns[term.key];
	return `${c.label}, ${term.desc ? c.desc : c.asc}`;
}

// A typed "^cost" or "^!cost", or null when the word isn't a sort. The key
// may still be half typed.
export function parseSortWord(word: string) {
	if (!word.startsWith("^")) return null;
	const desc = word[1] === "!";
	return { value: word.slice(desc ? 2 : 1).toLowerCase(), desc };
}

// Columns for a half-typed "^co": keys starting with it first, then ones
// whose key or label contains it. Columns already sorted on are left out.
export function suggestSorts<K extends string>(
	columns: SortColumns<K>,
	typed: string,
	picked: Sort<K>,
	limit = 8,
): K[] {
	const q = typed.toLowerCase();
	const taken = new Set(picked.map((t) => t.key));
	const keys = (Object.keys(columns) as K[]).filter((k) => !taken.has(k));
	const rank = (k: K) =>
		k.startsWith(q)
			? 0
			: k.includes(q) || columns[k].label.toLowerCase().includes(q)
				? 1
				: 2;
	return keys
		.filter((k) => rank(k) < 2)
		.sort((a, b) => rank(a) - rank(b))
		.slice(0, limit);
}

const text = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

function compare(a: SortValue, b: SortValue, desc: boolean) {
	// Blanks last in both directions.
	if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
	const order =
		typeof a === "number" && typeof b === "number"
			? a - b
			: text.compare(String(a), String(b));
	return desc ? -order : order;
}

// The rows in sort order. Each row's values are read once, not per comparison.
export function sortRows<T, K extends string>(
	rows: readonly T[],
	sort: Sort<K>,
	values: (row: T) => Record<K, SortValue>,
): T[] {
	if (sort.length === 0) return [...rows];
	const decorated = rows.map((row) => ({ row, v: values(row) }));
	decorated.sort((a, b) => {
		for (const t of sort) {
			const c = compare(a.v[t.key], b.v[t.key], t.desc);
			if (c !== 0) return c;
		}
		return 0;
	});
	return decorated.map((d) => d.row);
}
