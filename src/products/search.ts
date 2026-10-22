// The product search language. Plain words search name, SKU, and type; a
// word starting with a sigil filters instead:
//
//   #tag   @type   $vendor   %status   *class   &supplier   ~trust
//   #!tag  @!type  $!vendor  %!status  *!class  &!supplier  ~!trust   exclude
//   !!word                                       exclude titles containing word
//   +#tag                                        and, with the last chip on that field
//   <3  >3  =3  <=3  >=3                         inventory, as the Inventory column shows it
//   v<3  v>=0.5                                  velocity, units sold a month
//   ^cost  ^!cost                                sort, see sort.ts
//
// Several filters on one field match any of them (#a #b: tagged a or b),
// unless + joins them (#a +#b: tagged a and b; #a #b +#c: a, or b and c).
// Different fields must all match. Exclusions all apply. Inventory and
// velocity filters all apply too, so >2 <10 is a range.
//
// A filter still being typed matches by substring, so the list narrows live.
// Locking it in (Tab on a suggestion) makes it a chip that matches exactly.

import { parseSortWord } from "./sort";

// Every field, in one list so the URL and database checks (views.ts) can't
// fall behind the search language.
export const FIELDS = [
	"tag",
	"type",
	"vendor",
	"status",
	"class",
	"supplier",
	"trust",
	"title",
	"inventory",
	"velocity",
] as const;
export type Field = (typeof FIELDS)[number];

export type Filter = {
	field: Field;
	value: string;
	exclude: boolean;
	// Joined to the previous filter on the same field with AND instead of OR.
	// Exclusions all apply anyway, so it changes nothing for them.
	and: boolean;
	// Chips match the whole value; words still being typed match a part.
	exact: boolean;
};

// What a product offers each field. Several values per field, since a product
// has many tags and can be both "active" and "sold out".
export type Facets = Record<Exclude<Field, NumberField>, string[]> & {
	text: string[];
	inventory: number;
	// Units sold a month.
	velocity: number;
};

// Fields compared against a number rather than matched against values.
type NumberField = "inventory" | "velocity";
const isNumber = (field: Field): field is NumberField =>
	field === "inventory" || field === "velocity";

export const SIGILS = {
	"#": "tag",
	"@": "type",
	$: "vendor",
	"%": "status",
	"*": "class",
	"&": "supplier",
	"~": "trust",
} as const satisfies Record<string, Exclude<Field, "title" | NumberField>>;
export type ListField = (typeof SIGILS)[keyof typeof SIGILS];

const SIGIL_OF = Object.fromEntries(
	Object.entries(SIGILS).map(([sigil, field]) => [field, sigil]),
) as Record<ListField, string>;

// A comparison such as "<=3". The value of an inventory or velocity filter is
// the whole comparison. Velocity can be fractional, like 0.5 a month.
const COMPARISON = /^(<=|>=|<|>|=)(-?\d+(?:\.\d+)?)$/;
export function comparison(value: string) {
	const m = COMPARISON.exec(value);
	return m
		? { op: m[1] as "<" | "<=" | "=" | ">=" | ">", n: Number(m[2]) }
		: null;
}
// The test a comparison such as "<=3" makes of a number. Still being typed,
// e.g. "<", it tests nothing.
function comparer(value: string): (n: number) => boolean {
	const c = comparison(value);
	if (!c) return () => true;
	switch (c.op) {
		case "<":
			return (n) => n < c.n;
		case "<=":
			return (n) => n <= c.n;
		case "=":
			return (n) => n === c.n;
		case ">=":
			return (n) => n >= c.n;
		case ">":
			return (n) => n > c.n;
	}
}

// The typed form of a filter, e.g. "#!clearance", "+@box", or "!!refurb".
export function spell(f: Pick<Filter, "field" | "value" | "exclude" | "and">) {
	const and = f.and ? "+" : "";
	if (f.field === "title") return `${and}!!${f.value}`;
	if (f.field === "inventory") return f.value;
	if (f.field === "velocity") return `v${f.value}`;
	return `${and}${SIGIL_OF[f.field]}${f.exclude ? "!" : ""}${f.value}`;
}

// One typed word as a filter, or null when it's plain search text. A bare
// sigil ("#") is a filter with an empty value: it matches everything but
// tells autocomplete which field to suggest.
export function parseWord(typed: string): Filter | null {
	const and = typed.startsWith("+");
	const word = and ? typed.slice(1) : typed;
	if (word.startsWith("!!")) {
		return {
			field: "title",
			value: word.slice(2),
			exclude: true,
			and,
			exact: false,
		};
	}
	if (/^(<|>|=)/.test(word)) {
		return {
			field: "inventory",
			value: word,
			exclude: false,
			and,
			exact: true,
		};
	}
	if (/^v(<|>|=)/i.test(word)) {
		return {
			field: "velocity",
			value: word.slice(1),
			exclude: false,
			and,
			exact: true,
		};
	}
	const field = SIGILS[word[0] as keyof typeof SIGILS];
	if (!field) return null;
	const exclude = word[1] === "!";
	return {
		field,
		value: word.slice(exclude ? 2 : 1),
		exclude,
		and,
		exact: false,
	};
}

// Sorts typed but not yet locked in come back as `sorts`, for the page to
// apply once one names a column.
export function parseQuery(text: string) {
	const filters: Filter[] = [];
	const words: string[] = [];
	const sorts: NonNullable<ReturnType<typeof parseSortWord>>[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const filter = parseWord(word);
		const sort = parseSortWord(word);
		if (filter) filters.push(filter);
		else if (sort) sorts.push(sort);
		// A lone + is the start of "+#tag"; searching for it would empty the list.
		else if (word === "+") continue;
		else words.push(word.toLowerCase());
	}
	return { filters, words, sorts };
}

const lower = (s: string) => s.toLowerCase();

// Each product's text lowercased once, not once per search or facet count.
// Facets are built once per load, so the cache lives as long as they do.
type Folded = Record<Exclude<Field, NumberField> | "text", string[]>;
const folds = new WeakMap<Facets, Folded>();
function foldOf(facets: Facets): Folded {
	const known = folds.get(facets);
	if (known) return known;
	const out = { text: facets.text.map(lower) } as Folded;
	for (const field of FIELDS) {
		if (!isNumber(field)) out[field] = facets[field].map(lower);
	}
	folds.set(facets, out);
	return out;
}

type Term = { value: string; exact: boolean };
const termOf = (f: Filter): Term => ({
	value: f.value.toLowerCase(),
	exact: f.exact,
});
function hits(values: string[], t: Term) {
	return values.some((x) => (t.exact ? x === t.value : x.includes(t.value)));
}

// Whether a product passes the filters on one field.
type Check = (facets: Facets, folded: Folded) => boolean;
function checkOf(field: Field, fs: Filter[]): Check {
	if (isNumber(field)) {
		const tests = fs.map((f) => comparer(f.value));
		return (facets) => tests.every((test) => test(facets[field]));
	}
	// Per field, a list of alternatives; each alternative is filters that
	// must all match. + adds to the last alternative instead of starting one.
	const excluded = fs.filter((f) => f.exclude).map(termOf);
	const alternatives: Term[][] = [];
	for (const f of fs) {
		if (f.exclude) continue;
		const last = alternatives.at(-1);
		if (f.and && last) last.push(termOf(f));
		else alternatives.push([termOf(f)]);
	}
	return (_facets, folded) =>
		!excluded.some((t) => hits(folded[field], t)) &&
		(alternatives.length === 0 ||
			alternatives.some((all) => all.every((t) => hits(folded[field], t))));
}

// A search compiled once per edit: parsing and grouping happen here, so each
// product only runs the checks. missing names the fields whose filters a
// product fails, or is null when its free text fails, which no facet can
// make up for.
export function compile(filters: Filter[], words: string[]) {
	const text = words.map(lower);
	const checks = new Map<Field, Check>();
	for (const field of FIELDS) {
		const fs = filters.filter((f) => f.field === field && f.value !== "");
		if (fs.length > 0) checks.set(field, checkOf(field, fs));
	}
	const missing = (facets: Facets): Field[] | null => {
		const folded = foldOf(facets);
		if (!text.every((w) => folded.text.some((t) => t.includes(w)))) return null;
		const out: Field[] = [];
		for (const [field, check] of checks) {
			if (!check(facets, folded)) out.push(field);
		}
		return out;
	};
	return {
		missing,
		matches: (facets: Facets) => missing(facets)?.length === 0,
	};
}

export function matches(facets: Facets, filters: Filter[], words: string[]) {
	return compile(filters, words).matches(facets);
}

// Every value of each field across these products, with how many have it.
export function facetCounts(all: Facets[]) {
	const counts = new Map<ListField, Map<string, number>>();
	for (const facets of all) {
		for (const field of Object.values(SIGILS)) {
			const values = counts.get(field) ?? new Map<string, number>();
			for (const v of new Set(facets[field])) {
				values.set(v, (values.get(v) ?? 0) + 1);
			}
			counts.set(field, values);
		}
	}
	return counts;
}

// Values for the filter being typed: ones starting with it first, then ones
// containing it, most common first within each. Chips already picked are left
// out. Title exclusions are free text, so they get none.
export function suggest(
	counts: ReturnType<typeof facetCounts>,
	typing: Filter,
	picked: readonly Filter[],
	limit = 8,
) {
	if (typing.field === "title" || isNumber(typing.field)) return [];
	const q = typing.value.toLowerCase();
	const taken = new Set(
		picked
			.filter((f) => f.field === typing.field)
			.map((f) => f.value.toLowerCase()),
	);
	return [...(counts.get(typing.field) ?? new Map<string, number>())]
		.filter(([v]) => v.toLowerCase().includes(q) && !taken.has(v.toLowerCase()))
		.map(([value, count]) => ({
			value,
			count,
			prefix: value.toLowerCase().startsWith(q),
		}))
		.sort(
			(a, b) =>
				Number(b.prefix) - Number(a.prefix) ||
				b.count - a.count ||
				a.value.localeCompare(b.value),
		)
		.slice(0, limit)
		.map(({ value, count }) => ({ value, count }));
}
