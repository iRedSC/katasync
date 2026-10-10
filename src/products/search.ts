// The product search language. Plain words search name, SKU, and type; a
// word starting with a sigil filters instead:
//
//   #tag   @type   $vendor   %status
//   !#tag  !@type  !$vendor  !%status   exclude
//   !!word                              exclude titles containing word
//
// Several filters on one field match any of them (#a #b: tagged a or b);
// different fields must all match. Exclusions all apply.
//
// A filter still being typed matches by substring, so the list narrows live.
// Locking it in (Tab on a suggestion) makes it a chip that matches exactly.

export type Field = "tag" | "type" | "vendor" | "status" | "title";

export type Filter = {
	field: Field;
	value: string;
	exclude: boolean;
	// Chips match the whole value; words still being typed match a part.
	exact: boolean;
};

// What a product offers each field. Several values per field, since a product
// has many tags and can be both "active" and "sold out".
export type Facets = Record<Field, string[]> & { text: string[] };

export const SIGILS = {
	"#": "tag",
	"@": "type",
	$: "vendor",
	"%": "status",
} as const satisfies Record<string, Exclude<Field, "title">>;

const SIGIL_OF = Object.fromEntries(
	Object.entries(SIGILS).map(([sigil, field]) => [field, sigil]),
) as Record<Exclude<Field, "title">, string>;

// The typed form of a filter, e.g. "!#clearance" or "!!refurb".
export function spell(f: Pick<Filter, "field" | "value" | "exclude">) {
	if (f.field === "title") return `!!${f.value}`;
	return `${f.exclude ? "!" : ""}${SIGIL_OF[f.field]}${f.value}`;
}

// One typed word as a filter, or null when it's plain search text. A bare
// sigil ("#") is a filter with an empty value: it matches everything but
// tells autocomplete which field to suggest.
export function parseWord(word: string): Filter | null {
	if (word.startsWith("!!")) {
		return {
			field: "title",
			value: word.slice(2),
			exclude: true,
			exact: false,
		};
	}
	const exclude = word.startsWith("!");
	const rest = exclude ? word.slice(1) : word;
	const field = SIGILS[rest[0] as keyof typeof SIGILS];
	if (!field) return null;
	return { field, value: rest.slice(1), exclude, exact: false };
}

export function parseQuery(text: string) {
	const filters: Filter[] = [];
	const words: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const filter = parseWord(word);
		if (filter) filters.push(filter);
		else words.push(word.toLowerCase());
	}
	return { filters, words };
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
	if (active.some((f) => f.exclude && hits(facets[f.field], f))) return false;
	const wanted = new Map<Field, Filter[]>();
	for (const f of active) {
		if (!f.exclude) wanted.set(f.field, [...(wanted.get(f.field) ?? []), f]);
	}
	for (const [field, fs] of wanted) {
		if (!fs.some((f) => hits(facets[field], f))) return false;
	}
	return true;
}

// Every value of each field across these products, with how many have it.
export function facetCounts(all: Facets[]) {
	const counts = new Map<Field, Map<string, number>>();
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
	if (typing.field === "title") return [];
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
