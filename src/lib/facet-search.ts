// One search language for any list, described by its fields. Plain words
// search the row's text; a word starting with a field's sigil filters:
//
//   $tiktok   $!tiktok        a value, or leave it out
//   ~last_month               a period (lib/period.ts), one per list
//   ~2026-10-01..             picked days, open at either end
//   ^total  ^!date            sort, see products/sort.ts
//
// Several filters on one field match any of them, different fields must all
// match, and exclusions all apply. A filter still being typed matches by
// substring, so the list narrows live; a chip matches exactly.
//
// A list declares its fields once and gets parsing, matching, counts, what
// the search box suggests, the words that turn into sigils, the filter
// menu, and URL checks from that one declaration, so a field can't be in
// one of them and missing from another. The products list has a richer
// language of its own (products/search.ts) behind the same search box.

import { type } from "arktype";
import type { FieldEntry } from "#/components/filter-fields";
import { type MatchText, matchText, textMatcher } from "#/lib/search-ranking";
import {
	type Day,
	dayOf,
	daysOf,
	describePeriod,
	isAllTime,
	parseDay,
	parsePeriod,
	RANGES,
	type RangeKey,
	spellPeriod,
	today,
	within,
} from "./period";

export type Chip<K extends string = string> = {
	field: K;
	value: string;
	exclude: boolean;
	// Chips match the whole value; words still being typed match a part.
	exact: boolean;
};

type Common = {
	sigil: string;
	// On a chip: "sold on", "not sold on".
	label: string;
	// In the menus: "Marketplace".
	menu: string;
	// Words that turn into the sigil once a space follows them.
	words: readonly string[];
};

// A field rows have values for, like a status or a supplier.
export type ValuesField<R> = Common & {
	kind: "values";
	of: (row: R) => readonly (string | null)[] | string | null;
	// Values offered even when no row has them yet, so the menu teaches them.
	known?: readonly string[];
	// What a value means when its name alone doesn't.
	details?: ReadonlyMap<string, string>;
	// Only known values can be chips, since any other could never match.
	closed?: boolean;
};

// When rows happened. One period per list: a new one replaces the last.
export type PeriodField<R> = Common & {
	kind: "period";
	// When a row happened, or null where the page loads rows by the period
	// itself, so filtering them again would change nothing. A row with no
	// date is in no period.
	at: ((row: R) => Date | string | null) | null;
};

export type SearchField<R> = ValuesField<R> | PeriodField<R>;

// A suggestion for a filter being typed.
export type Suggestion = {
	value: string;
	// Shown instead of the value, e.g. "Last month" for last_month.
	display?: string;
	count?: number;
	detail?: string;
	// Picking it opens the field's picker rather than locking in a chip.
	opens?: boolean;
};

// The value a period suggestion opens the calendar with.
export const CUSTOM = "custom";

export type Index<K extends string> = {
	// Per row, each field's values (lowercased) and its text.
	facets: { values: Record<K, string[]>; day: Day | null; text: MatchText }[];
	// Every value of each field across the rows, with how many have it.
	counts: Map<K, Map<string, number>>;
};

export function defineSearch<R, K extends string>(def: {
	fields: { readonly [k in K]: SearchField<R> };
	// Everything plain words find a row by.
	text: (row: R) => readonly (string | number | null | undefined)[];
}) {
	const keys = Object.keys(def.fields) as K[];
	const fields = def.fields as Record<K, SearchField<R>>;
	const bySigil = new Map(keys.map((k) => [fields[k].sigil, k]));
	const periodKey = keys.find((k) => fields[k].kind === "period");

	const valuesOf = (f: ValuesField<R>, row: R) => {
		const v = f.of(row);
		return (typeof v === "string" ? [v] : (v ?? [])).filter(
			(x): x is string => typeof x === "string" && x !== "",
		);
	};

	// One typed word as a filter, or null when it's plain search text. A bare
	// sigil ("$") is a filter with an empty value: it matches everything but
	// tells autocomplete which field to suggest. Longer sigils win, so "!!"
	// isn't read as "!".
	const sigils = [...bySigil.keys()].sort((a, b) => b.length - a.length);
	function parse(word: string): Chip<K> | null {
		const sigil = sigils.find((s) => word.startsWith(s));
		if (sigil === undefined) return null;
		const field = bySigil.get(sigil) as K;
		const rest = word.slice(sigil.length);
		const exclude = fields[field].kind === "values" && rest.startsWith("!");
		return {
			field,
			value: exclude ? rest.slice(1) : rest,
			exclude,
			exact: false,
		};
	}

	// Sorts typed but not yet locked in come back as `sorts`, for the page to
	// apply once one names a column.
	function parseQuery(text: string) {
		const filters: Chip<K>[] = [];
		const words: string[] = [];
		const sorts: { value: string; desc: boolean }[] = [];
		for (const word of text.split(/\s+/).filter(Boolean)) {
			const filter = parse(word);
			if (filter) filters.push(filter);
			else if (word.startsWith("^")) {
				const desc = word[1] === "!";
				sorts.push({ value: word.slice(desc ? 2 : 1).toLowerCase(), desc });
			} else words.push(word.toLowerCase());
		}
		return { filters, words, sorts };
	}

	function index(rows: readonly R[], on: Day = today()): Index<K> {
		const counts = new Map<K, Map<string, number>>();
		for (const k of keys) {
			const f = fields[k];
			counts.set(
				k,
				new Map(
					f.kind === "values"
						? (f.known ?? []).map((v) => [v, 0])
						: (Object.keys(RANGES) as RangeKey[]).map((r) => [r, 0]),
				),
			);
		}
		const facets = rows.map((row) => {
			const values = {} as Record<K, string[]>;
			let day: Day | null = null;
			for (const k of keys) {
				const f = fields[k];
				const tally = counts.get(k) as Map<string, number>;
				if (f.kind === "values") {
					const vs = [...new Set(valuesOf(f, row))];
					for (const v of vs) tally.set(v, (tally.get(v) ?? 0) + 1);
					values[k] = vs.map((v) => v.toLowerCase());
				} else {
					values[k] = [];
					const at = f.at?.(row);
					if (!at) continue;
					day = dayOfRow(at);
					for (const r of tally.keys()) {
						const span = daysOf({ kind: "range", key: r as RangeKey }, on);
						if (within(day, span)) tally.set(r, (tally.get(r) ?? 0) + 1);
					}
				}
			}
			const text = matchText(
				def
					.text(row)
					.filter((t) => t !== null && t !== undefined && t !== "")
					.join(" "),
			);
			return { values, day, text };
		});
		return { facets, counts };
	}

	// The rows these chips and typed words keep, in their order.
	function filter<T extends R>(
		rows: readonly T[],
		idx: Index<K>,
		chips: readonly Chip<K>[],
		words: readonly string[],
		on: Day = today(),
	): T[] {
		const active = chips.filter((c) => c.value !== "");
		const tests = keys.flatMap((k) => {
			const f = fields[k];
			const mine = active.filter((c) => c.field === k);
			if (mine.length === 0) return [];
			if (f.kind === "period") {
				if (!f.at) return [];
				// A half-typed period filters nothing until it means one.
				const p = parsePeriod(mine.at(-1)?.value ?? "");
				if (!p) return [];
				const span = daysOf(p, on);
				return [
					(fs: Index<K>["facets"][number]) =>
						fs.day !== null && within(fs.day, span),
				];
			}
			const hit = (values: string[], c: Chip<K>) => {
				const v = c.value.toLowerCase();
				return values.some((x) => (c.exact ? x === v : x.includes(v)));
			};
			const out = mine.filter((c) => c.exclude);
			const wanted = mine.filter((c) => !c.exclude);
			return [
				(fs: Index<K>["facets"][number]) =>
					!out.some((c) => hit(fs.values[k], c)) &&
					(wanted.length === 0 || wanted.some((c) => hit(fs.values[k], c))),
			];
		});
		const typed = textMatcher(words.join(" "));
		return rows.filter((_, i) => {
			const fs = idx.facets[i];
			return typed(fs.text) && tests.every((t) => t(fs));
		});
	}

	// The chip a picked or typed value locks in as, or null when it can't be
	// one: a closed field's unknown value, or a period that isn't one.
	function lock(
		typing: Chip<K>,
		value: string,
		idx?: Index<K>,
	): Chip<K> | null {
		const f = fields[typing.field];
		if (f.kind === "period") {
			const p = parsePeriod(value.toLowerCase());
			return p ? { ...typing, value: spellPeriod(p), exact: true } : null;
		}
		if (!f.closed) return { ...typing, value, exact: true };
		const known = [
			...(f.known ?? []),
			...(idx?.counts.get(typing.field)?.keys() ?? []),
		].find((v) => v.toLowerCase() === value.toLowerCase());
		return known ? { ...typing, value: known, exact: true } : null;
	}

	// A new period replaces the last, and all time is no chip at all.
	function add(chips: readonly Chip<K>[], chip: Chip<K>): Chip<K>[] {
		if (fields[chip.field].kind !== "period") return [...chips, chip];
		const rest = chips.filter((c) => c.field !== chip.field);
		const p = parsePeriod(chip.value);
		return p && isAllTime(p) ? rest : [...rest, chip];
	}

	function suggest(
		idx: Index<K>,
		typing: Chip<K>,
		chips: readonly Chip<K>[],
		limit = 50,
	): Suggestion[] {
		const f = fields[typing.field];
		const q = typing.value.toLowerCase();
		const counts = idx.counts.get(typing.field) ?? new Map<string, number>();
		if (f.kind === "period") {
			const named = (Object.keys(RANGES) as RangeKey[])
				.filter(
					(r) =>
						r.startsWith(q) ||
						RANGES[r].toLowerCase().includes(q.replace(/_/g, " ")),
				)
				.map(
					(r): Suggestion => ({
						value: r,
						display: RANGES[r],
						count: f.at ? counts.get(r) : undefined,
					}),
				);
			const typed = parsePeriod(q);
			const days: Suggestion[] =
				typed && typed.kind === "days"
					? [{ value: spellPeriod(typed), display: describePeriod(typed) }]
					: [];
			const custom: Suggestion[] = "custom dates pick".includes(q.split(" ")[0])
				? [{ value: CUSTOM, display: "Custom…", opens: true }]
				: [];
			return [...days, ...named, ...custom];
		}
		const taken = new Set(
			chips
				.filter((c) => c.field === typing.field)
				.map((c) => c.value.toLowerCase()),
		);
		return [...counts]
			.filter(
				([v]) => v.toLowerCase().includes(q) && !taken.has(v.toLowerCase()),
			)
			.map(([value, count]) => ({
				value,
				count,
				detail: f.details?.get(value),
				prefix: value.toLowerCase().startsWith(q),
			}))
			.sort(
				(a, b) =>
					Number(b.prefix) - Number(a.prefix) ||
					b.count - a.count ||
					a.value.localeCompare(b.value),
			)
			.slice(0, limit)
			.map(({ prefix: _, ...s }) => s);
	}

	// What a chip says after its label: the value, or a period in words.
	function show(c: Chip<K>) {
		if (fields[c.field].kind !== "period") return c.value;
		const p = parsePeriod(c.value);
		return p ? describePeriod(p) : c.value;
	}

	function label(c: Chip<K>) {
		const f = fields[c.field];
		return c.exclude ? `not ${f.label}` : f.label;
	}

	function fallback(typing: Chip<K>) {
		const f = fields[typing.field];
		if (f.kind === "period")
			return "Pick a range, or type days as 2026-10-01..";
		return f.closed
			? `No ${f.menu.toLowerCase()} “${typing.value}”`
			: `None “${typing.value}” yet. Tab to use anyway.`;
	}

	// The filter types the box offers while nothing is typed, and the words
	// that become their sigils.
	const entries: readonly FieldEntry[] = keys.map((k) => ({
		label: fields[k].menu,
		insert: fields[k].sigil,
		words: fields[k].words,
		negatable: fields[k].kind === "values",
	}));

	// Chips as they travel through the URL. Anything malformed, or naming a
	// value that can no longer match, is dropped, so an old link still opens.
	const chipsType = type({
		field: type.enumerated(...(keys as string[])),
		value: "string",
		exclude: "boolean",
		exact: "boolean",
	}).array();
	function chipsFromUrl(raw: unknown): Chip<K>[] {
		const chips = chipsType(raw);
		if (chips instanceof type.errors) return [];
		return chips.reduce<Chip<K>[]>((all, c) => {
			const chip = lock(c as Chip<K>, c.value);
			return chip ? add(all, chip) : all;
		}, []);
	}

	return {
		fields,
		keys,
		periodKey,
		parse,
		parseQuery,
		index,
		filter,
		lock,
		add,
		suggest,
		show,
		label,
		fallback,
		entries,
		chipsFromUrl,
	};
}

export type Search<R, K extends string> = ReturnType<typeof defineSearch<R, K>>;

// A bare "2026-10-21" is already a shop day; anything else is an instant.
const dayOfRow = (at: Date | string) =>
	(typeof at === "string" && parseDay(at)) || dayOf(at);
