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
function compare(n: number, value: string) {
	const c = comparison(value);
	if (!c) return true; // still being typed, e.g. "<"
	switch (c.op) {
		case "<":
			return n < c.n;
		case "<=":
			return n <= c.n;
		case "=":
			return n === c.n;
		case ">=":
			return n >= c.n;
		case ">":
			return n > c.n;
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

function hits(values: string[], f: Filter) {
	const v = f.value.toLowerCase();
	return values.some((x) =>
		f.exact ? x.toLowerCase() === v : x.toLowerCase().includes(v),
	);
}

export function matches(facets: Facets, filters: Filter[], words: string[]) {
	const text = facets.text.map((t) => t.toLowerCase());
	if (!words.every((w) => text.some((t) => t.includes(w)))) return false;

	const active = filters.filter((f) => f.value !== "");
	if (
		!active.every(
			(f) => !isNumber(f.field) || compare(facets[f.field], f.value),
		)
	)
		return false;
	const lists = active.filter(
		(f): f is Filter & { field: Exclude<Field, NumberField> } =>
			!isNumber(f.field),
	);
	if (lists.some((f) => f.exclude && hits(facets[f.field], f))) return false;
	// Per field, a list of alternatives; each alternative is filters that
	// must all match. + adds to the last alternative instead of starting one.
	const wanted = new Map<Exclude<Field, NumberField>, Filter[][]>();
	for (const f of lists) {
		if (f.exclude) continue;
		const alternatives = wanted.get(f.field) ?? [];
		const last = alternatives.at(-1);
		if (f.and && last) last.push(f);
		else alternatives.push([f]);
		wanted.set(f.field, alternatives);
	}
	for (const [field, alternatives] of wanted) {
		const ok = alternatives.some((all) =>
			all.every((f) => hits(facets[field], f)),
		);
		if (!ok) return false;
	}
	return true;
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
	picked: Filter[],
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
